import { parseBody, route } from "@/lib/server/api";
import { createAgent, listAgents } from "@/lib/server/agents/store";
import { requireAccount } from "@/lib/server/session";
import { agentInputSchema } from "@/lib/shared/agents";

export const GET = route(async () => {
  const account = await requireAccount();
  return { agents: listAgents(account.id) };
});

export const POST = route(async (req) => {
  const account = await requireAccount();
  return { agent: createAgent(account.id, await parseBody(req, agentInputSchema)) };
});
