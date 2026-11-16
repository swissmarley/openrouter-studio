import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { ApiError, parseBody, route } from "@/lib/server/api";
import { requireAccount } from "@/lib/server/session";
import { datasetInputSchema } from "@/lib/shared/evals";

type Ctx = { params: Promise<{ id: string }> };

async function owned(ctx: Ctx) {
  const account = await requireAccount();
  const id = (await ctx.params).id;
  const where = and(eq(schema.evalDatasets.id, id), eq(schema.evalDatasets.accountId, account.id));
  if (!getDb().select({ id: schema.evalDatasets.id }).from(schema.evalDatasets).where(where).get()) throw new ApiError(404, "not_found", "Dataset not found.");
  return where;
}

export const PUT = route<Ctx>(async (req, ctx) => {
  const where = await owned(ctx);
  const input = await parseBody(req, datasetInputSchema);
  getDb().update(schema.evalDatasets).set({ name: input.name, rows: input.rows, updatedAt: Date.now() }).where(where).run();
  return { ok: true };
});

export const DELETE = route<Ctx>(async (_req, ctx) => {
  getDb().delete(schema.evalDatasets).where(await owned(ctx)).run();
  return { ok: true };
});
