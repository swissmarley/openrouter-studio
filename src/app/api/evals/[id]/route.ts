import { z } from "zod";
import { parseBody, route } from "@/lib/server/api";
import { cancelEval, deleteEval, getEval } from "@/lib/server/evals";
import { requireAccount } from "@/lib/server/session";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route<Ctx>(async (_req, ctx) => {
  const account = await requireAccount();
  return getEval(account.id, (await ctx.params).id);
});

export const POST = route<Ctx>(async (req, ctx) => {
  const account = await requireAccount();
  await parseBody(req, z.object({ action: z.literal("cancel") }));
  cancelEval(account.id, (await ctx.params).id);
  return { ok: true };
});

export const DELETE = route<Ctx>(async (_req, ctx) => {
  const account = await requireAccount();
  deleteEval(account.id, (await ctx.params).id);
  return { ok: true };
});
