import { and, desc, eq, lt } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { parseBody, parseQuery, route } from "@/lib/server/api";
import { buildSnapshot, startRun } from "@/lib/server/agents/runner";
import { toRunSummary } from "@/lib/server/agents/summary";
import { requireAccount } from "@/lib/server/session";
import { startRunSchema } from "@/lib/shared/runs";

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(40),
  before: z.coerce.number().int().positive().optional(),
  agentId: z.string().max(80).optional(),
});

export const GET = route(async (req) => {
  const account = await requireAccount();
  const q = parseQuery(req, querySchema);
  const rows = getDb()
    .select()
    .from(schema.runs)
    .where(
      and(
        eq(schema.runs.accountId, account.id),
        q.before ? lt(schema.runs.createdAt, q.before) : undefined,
        q.agentId ? eq(schema.runs.agentId, q.agentId) : undefined,
      ),
    )
    .orderBy(desc(schema.runs.createdAt))
    .limit(q.limit)
    .all();
  return { runs: rows.map(toRunSummary) };
});

/** Starts a run. It executes in the background; follow it at /api/runs/:id/events. */
export const POST = route(async (req) => {
  const account = await requireAccount();
  const { agentId, input } = await parseBody(req, startRunSchema);
  const snapshot = buildSnapshot(account.id, agentId);
  const id = startRun({ accountId: account.id, apiKey: account.apiKey(), snapshot, input, agentId });
  return { id };
});
