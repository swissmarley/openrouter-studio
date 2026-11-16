import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { ApiError, route } from "@/lib/server/api";
import { getController, getRunRow, listEvents } from "@/lib/server/agents/runner";
import { toRunSummary } from "@/lib/server/agents/summary";
import { requireAccount } from "@/lib/server/session";
import { isTerminal } from "@/lib/shared/runs";

type Ctx = { params: Promise<{ id: string }> };

/** A run with its full stored trace: what the replay view plays back. */
export const GET = route<Ctx>(async (_req, ctx) => {
  const account = await requireAccount();
  const row = getRunRow(account.id, (await ctx.params).id);
  return { run: toRunSummary(row), events: listEvents(row.id), live: getController(row.id) !== undefined };
});

export const DELETE = route<Ctx>(async (_req, ctx) => {
  const account = await requireAccount();
  const row = getRunRow(account.id, (await ctx.params).id);
  if (!isTerminal(row.status) && getController(row.id)) throw new ApiError(409, "still_running", "Cancel the run before deleting it.");
  // run_events rows go with it (ON DELETE CASCADE).
  getDb().delete(schema.runs).where(eq(schema.runs.id, row.id)).run();
  return { ok: true };
});
