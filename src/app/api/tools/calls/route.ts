import { and, desc, eq, lt } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { parseQuery, route } from "@/lib/server/api";
import { requireAccount } from "@/lib/server/session";

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.coerce.number().int().positive().optional(),
  runId: z.string().max(80).optional(),
});

/** The tool-call audit log, newest first. */
export const GET = route(async (req) => {
  const account = await requireAccount();
  const q = parseQuery(req, querySchema);
  const rows = getDb()
    .select()
    .from(schema.toolCalls)
    .where(
      and(
        eq(schema.toolCalls.accountId, account.id),
        q.before ? lt(schema.toolCalls.ts, q.before) : undefined,
        q.runId ? eq(schema.toolCalls.runId, q.runId) : undefined,
      ),
    )
    .orderBy(desc(schema.toolCalls.ts))
    .limit(q.limit)
    .all();
  return { calls: rows };
});
