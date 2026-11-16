import "server-only";
import { and, eq, gte, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { usd } from "@/lib/shared/format";
import { defaultSettings, settingsSchema, type Settings } from "@/lib/shared/settings";
import { ApiError } from "./api";

export function getSettings(accountId: string): Settings {
  const row = getDb().select().from(schema.settings).where(eq(schema.settings.accountId, accountId)).get();
  if (!row) return defaultSettings;
  const parsed = settingsSchema.safeParse(row.data);
  return parsed.success ? parsed.data : defaultSettings;
}

export function saveSettings(accountId: string, next: Settings): Settings {
  const data = settingsSchema.parse(next);
  getDb()
    .insert(schema.settings)
    .values({ accountId, data, updatedAt: Date.now() })
    .onConflictDoUpdate({ target: schema.settings.accountId, set: { data, updatedAt: Date.now() } })
    .run();
  return data;
}

function spendSince(accountId: string, sinceMs: number): number {
  const row = getDb()
    .select({ total: sql<number>`coalesce(sum(${schema.requestLogs.cost}), 0)` })
    .from(schema.requestLogs)
    .where(and(eq(schema.requestLogs.accountId, accountId), gte(schema.requestLogs.ts, sinceMs)))
    .get();
  return row?.total ?? 0;
}

export interface BudgetWindow {
  period: "daily" | "monthly";
  limitUsd: number;
  spentUsd: number;
  ratio: number;
  /** Highest configured threshold that spend has crossed, if any. */
  crossed: number | null;
  exceeded: boolean;
}

export interface BudgetStatus {
  windows: BudgetWindow[];
  hardStop: boolean;
  blocked: boolean;
}

/** Budget windows are UTC days and UTC calendar months, matching OpenRouter's own accounting. */
export function getBudgetStatus(accountId: string, settings = getSettings(accountId)): BudgetStatus {
  const now = new Date();
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const thresholds = [...settings.budgets.alertThresholds].sort((a, b) => a - b);

  const windows: BudgetWindow[] = [];
  const add = (period: BudgetWindow["period"], limitUsd: number | null, since: number) => {
    if (limitUsd === null) return;
    const spentUsd = spendSince(accountId, since);
    const ratio = spentUsd / limitUsd;
    const crossed = thresholds.filter((t) => ratio >= t).pop() ?? null;
    windows.push({ period, limitUsd, spentUsd, ratio, crossed, exceeded: ratio >= 1 });
  };
  add("daily", settings.budgets.dailyUsd, dayStart);
  add("monthly", settings.budgets.monthlyUsd, monthStart);

  return {
    windows,
    hardStop: settings.budgets.hardStop,
    blocked: settings.budgets.hardStop && windows.some((w) => w.exceeded),
  };
}

/** Called before every billable upstream request. */
export function assertWithinBudget(accountId: string): void {
  const status = getBudgetStatus(accountId);
  if (!status.blocked) return;
  const hit = status.windows.find((w) => w.exceeded)!;
  throw new ApiError(
    402,
    "budget_exceeded",
    `Your ${hit.period} budget of ${usd(hit.limitUsd)} is spent (${usd(hit.spentUsd)} used). Raise it in Settings to continue.`,
    hit,
  );
}
