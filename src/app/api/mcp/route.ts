import { parseBody, route } from "@/lib/server/api";
import { createMcpServer, listMcpServers } from "@/lib/server/agents/store";
import { requireAccount } from "@/lib/server/session";
import { mcpServerInputSchema } from "@/lib/shared/agents";

export const GET = route(async () => {
  const account = await requireAccount();
  return { servers: listMcpServers(account.id) };
});

export const POST = route(async (req) => {
  const account = await requireAccount();
  return { server: createMcpServer(account.id, await parseBody(req, mcpServerInputSchema)) };
});
