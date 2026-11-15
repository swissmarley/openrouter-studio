import { parseBody, route } from "@/lib/server/api";
import { deleteAgent, getAgent, updateAgent } from "@/lib/server/agents/store";
import { requireAccount } from "@/lib/server/session";
import { agentInputSchema } from "@/lib/shared/agents";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route<Ctx>(async (_req, ctx) => {
  const account = await requireAccount();
  return { agent: getAgent(account.id, (await ctx.params).id) };
});

export const PUT = route<Ctx>(async (req, ctx) => {
  const account = await requireAccount();
  return { agent: updateAgent(account.id, (await ctx.params).id, await parseBody(req, agentInputSchema)) };
});

export const DELETE = route<Ctx>(async (_req, ctx) => {
  const account = await requireAccount();
  deleteAgent(account.id, (await ctx.params).id);
  return { ok: true };
});
