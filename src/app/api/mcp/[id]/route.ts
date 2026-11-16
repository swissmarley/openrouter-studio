import { parseBody, route } from "@/lib/server/api";
import { deleteMcpServer, updateMcpServer } from "@/lib/server/agents/store";
import { requireAccount } from "@/lib/server/session";
import { mcpServerInputSchema } from "@/lib/shared/agents";

type Ctx = { params: Promise<{ id: string }> };

export const PUT = route<Ctx>(async (req, ctx) => {
  const account = await requireAccount();
  return { server: updateMcpServer(account.id, (await ctx.params).id, await parseBody(req, mcpServerInputSchema)) };
});

export const DELETE = route<Ctx>(async (_req, ctx) => {
  const account = await requireAccount();
  deleteMcpServer(account.id, (await ctx.params).id);
  return { ok: true };
});
