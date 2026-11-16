import "server-only";
import { and, eq, gte, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { orJson, UpstreamError } from "./openrouter";

/**
 * Usage and spend. Two sources, shown side by side:
 *  - OpenRouter's own numbers for the key and account (/key, /credits, /activity). The
 *    last two need a management key, so they are optional here.
 *  - This app's request log, which covers exactly the calls made through this app and
 *    is what budgets are measured against.
 */

export interface Credits {
  totalCredits: number;
  totalUsage: number;
  remaining: number;
}

export interface ActivityRow {
  date: string;
  model: string;
  provider: string | null;
  usage: number;
  requests: number;
  promptTokens: number;
  completionTokens: number;
}

type Optional<T> = { data: T; unavailable: null } | { data: null; unavailable: string };

/** Calls an endpoint that only some keys may use, turning "not allowed" into a reason instead of an error. */
async function optional<T>(run: () => Promise<T>): Promise<Optional<T>> {
  try {
    return { data: await run(), unavailable: null };
  } catch (err) {
    if (err instanceof UpstreamError && [401, 403, 404, 502].includes(err.status)) {
      return { data: null, unavailable: err.status === 403 || err.status === 502 ? "This needs a management key." : err.message };
    }
    return { data: null, unavailable: (err as Error).message };
  }
}

export function fetchCredits(accountId: string, apiKey: string): Promise<Optional<Credits>> {
  return optional(async () => {
    const body = await orJson<{ data: { total_credits?: number; total_usage?: number } }>(apiKey, "/credits", {}, { accountId, kind: "meta" });
    const totalCredits = body.data?.total_credits ?? 0;
    const totalUsage = body.data?.total_usage ?? 0;
    return { totalCredits, totalUsage, remaining: totalCredits - totalUsage };
  });
}

export function fetchActivity(accountId: string, apiKey: string): Promise<Optional<ActivityRow[]>> {
  return optional(async () => {
    const body = await orJson<{ data: Record<string, unknown>[] }>(apiKey, "/activity", {}, { accountId, kind: "meta" });
    return (body.data ?? []).map((r) => ({
      date: String(r.date ?? "").slice(0, 10),
      model: String(r.model ?? r.model_permaslug ?? ""),
      provider: typeof r.provider_name === "string" ? r.provider_name : null,
      usage: Number(r.usage ?? 0),
      requests: Number(r.requests ?? 0),
      promptTokens: Number(r.prompt_tokens ?? 0),
      completionTokens: Number(r.completion_tokens ?? 0),
    }));
  });
}

export interface LocalUsage {
  windows: { label: string; requests: number; cost: number; promptTokens: number; completionTokens: number; errors: number; retries: number }[];
  byDay: { day: string; cost: number; requests: number }[];
  byModel: { model: string; requests: number; cost: number; promptTokens: number; completionTokens: number; avgLatencyMs: number | null; errors: number }[];
  byKind: { kind: string; requests: number; cost: number }[];
  latency: { p50: number | null; p95: number | null };
}

const DAY = 86_400_000;
const logs = schema.requestLogs;
// "meta" rows are catalog/key lookups: free, and not what anyone means by usage.
const billable = sql`${logs.kind} != 'meta'`;

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

/** Aggregates this app's own request log. */
export function localUsage(accountId: string, now = Date.now()): LocalUsage {
  const db = getDb();
  const scope = (since: number) => and(eq(logs.accountId, accountId), billable, gte(logs.ts, since));
  const todayStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());

  const window = (label: string, since: number) => {
    const row = db
      .select({
        requests: sql<number>`count(*)`,
        cost: sql<number>`coalesce(sum(${logs.cost}), 0)`,
        promptTokens: sql<number>`coalesce(sum(${logs.promptTokens}), 0)`,
        completionTokens: sql<number>`coalesce(sum(${logs.completionTokens}), 0)`,
        errors: sql<number>`coalesce(sum(case when ${logs.ok} = 0 then 1 else 0 end), 0)`,
        retries: sql<number>`coalesce(sum(${logs.retries}), 0)`,
      })
      .from(logs)
      .where(scope(since))
      .get()!;
    return { label, ...row };
  };

  const since30 = todayStart - 29 * DAY;
  const dayRows = db
    .select({ day: sql<string>`strftime('%Y-%m-%d', ${logs.ts} / 1000, 'unixepoch')`, cost: sql<number>`coalesce(sum(${logs.cost}), 0)`, requests: sql<number>`count(*)` })
    .from(logs)
    .where(scope(since30))
    .groupBy(sql`1`)
    .all();
  const byDayMap = new Map(dayRows.map((r) => [r.day, r]));
  // Fill gaps so the chart has one bar per day, including days with no traffic.
  const byDay = Array.from({ length: 30 }, (_, i) => {
    const day = new Date(since30 + i * DAY).toISOString().slice(0, 10);
    return { day, cost: byDayMap.get(day)?.cost ?? 0, requests: byDayMap.get(day)?.requests ?? 0 };
  });

  const byModel = db
    .select({
      model: sql<string>`coalesce(${logs.modelUsed}, ${logs.model}, 'unknown')`,
      requests: sql<number>`count(*)`,
      cost: sql<number>`coalesce(sum(${logs.cost}), 0)`,
      promptTokens: sql<number>`coalesce(sum(${logs.promptTokens}), 0)`,
      completionTokens: sql<number>`coalesce(sum(${logs.completionTokens}), 0)`,
      avgLatencyMs: sql<number | null>`avg(case when ${logs.ok} = 1 then ${logs.latencyMs} end)`,
      errors: sql<number>`coalesce(sum(case when ${logs.ok} = 0 then 1 else 0 end), 0)`,
    })
    .from(logs)
    .where(scope(since30))
    .groupBy(sql`1`)
    .orderBy(sql`3 desc`, sql`2 desc`)
    .limit(12)
    .all();

  const byKind = db
    .select({ kind: logs.kind, requests: sql<number>`count(*)`, cost: sql<number>`coalesce(sum(${logs.cost}), 0)` })
    .from(logs)
    .where(scope(since30))
    .groupBy(logs.kind)
    .orderBy(sql`3 desc`)
    .all();

  const latencies = db
    .select({ ms: logs.latencyMs })
    .from(logs)
    .where(and(scope(now - 7 * DAY), eq(logs.ok, true)))
    .all()
    .map((r) => r.ms ?? 0)
    .sort((a, b) => a - b);

  return {
    windows: [window("Today", todayStart), window("Last 7 days", todayStart - 6 * DAY), window("Last 30 days", since30)],
    byDay,
    byModel,
    byKind,
    latency: { p50: percentile(latencies, 50), p95: percentile(latencies, 95) },
  };
}
