import { parseBody, route } from "@/lib/server/api";
import { createCustomTool, listCustomTools } from "@/lib/server/agents/store";
import { requireAccount } from "@/lib/server/session";
import { customToolInputSchema } from "@/lib/shared/agents";

export const GET = route(async () => {
  const account = await requireAccount();
  return { tools: listCustomTools(account.id) };
});

export const POST = route(async (req) => {
  const account = await requireAccount();
  return { tool: createCustomTool(account.id, await parseBody(req, customToolInputSchema)) };
});
