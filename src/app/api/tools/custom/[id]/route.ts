import { parseBody, route } from "@/lib/server/api";
import { deleteCustomTool, updateCustomTool } from "@/lib/server/agents/store";
import { requireAccount } from "@/lib/server/session";
import { customToolInputSchema } from "@/lib/shared/agents";

type Ctx = { params: Promise<{ id: string }> };

export const PUT = route<Ctx>(async (req, ctx) => {
  const account = await requireAccount();
  return { tool: updateCustomTool(account.id, (await ctx.params).id, await parseBody(req, customToolInputSchema)) };
});

export const DELETE = route<Ctx>(async (_req, ctx) => {
  const account = await requireAccount();
  deleteCustomTool(account.id, (await ctx.params).id);
  return { ok: true };
});
