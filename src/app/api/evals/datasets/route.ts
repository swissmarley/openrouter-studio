import { desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { parseBody, route } from "@/lib/server/api";
import { newId } from "@/lib/server/crypto";
import { requireAccount } from "@/lib/server/session";
import { datasetInputSchema } from "@/lib/shared/evals";

export const GET = route(async () => {
  const account = await requireAccount();
  const rows = getDb().select().from(schema.evalDatasets).where(eq(schema.evalDatasets.accountId, account.id)).orderBy(desc(schema.evalDatasets.updatedAt)).all();
  return { datasets: rows.map(({ id, name, rows, updatedAt }) => ({ id, name, rows, updatedAt })) };
});

export const POST = route(async (req) => {
  const account = await requireAccount();
  const input = await parseBody(req, datasetInputSchema);
  const id = newId("ds");
  getDb().insert(schema.evalDatasets).values({ id, accountId: account.id, name: input.name, rows: input.rows }).run();
  return { dataset: { id, ...input } };
});
