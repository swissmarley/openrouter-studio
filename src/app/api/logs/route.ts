import { and, desc, eq, like, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { parseQuery, route } from "@/lib/server/api";
import { requireAccount } from "@/lib/server/session";

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  before: z.coerce.number().int().positive().optional(),
  kind: z.enum(["chat", "responses", "agent", "eval", "meta"]).optional(),
  status: z.enum(["ok", "error", "retried"]).optional(),
  model: z.string().max(200).optional(),
});

/** Request log: one row per upstream OpenRouter call made through this app. */
export const GET = route(async (req) => {
  const account = await requireAccount();
  const q = parseQuery(req, querySchema);
  const logs = schema.requestLogs;
  const rows = getDb()
    .select()
    .from(logs)
    .where(
      and(
        eq(logs.accountId, account.id),
        q.before ? lt(logs.ts, q.before) : undefined,
        // Catalog and key lookups are hidden unless asked for.
        q.kind ? eq(logs.kind, q.kind) : sql`${logs.kind} != 'meta'`,
        q.status === "ok" ? eq(logs.ok, true) : q.status === "error" ? eq(logs.ok, false) : q.status === "retried" ? sql`${logs.retries} > 0` : undefined,
        q.model ? like(sql`coalesce(${logs.modelUsed}, ${logs.model}, '')`, `%${q.model.replace(/[%_]/g, "")}%`) : undefined,
      ),
    )
    .orderBy(desc(logs.ts))
    .limit(q.limit)
    .all();
  return { logs: rows, nextBefore: rows.length === q.limit ? rows[rows.length - 1].ts : null };
});
