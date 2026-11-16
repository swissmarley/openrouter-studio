import { route } from "@/lib/server/api";
import { getMcpRow, listMcpServers, recordMcpProbe } from "@/lib/server/agents/store";
import { requireAccount } from "@/lib/server/session";
import { connectMcp, describeTools } from "@/lib/server/tools/mcp";

type Ctx = { params: Promise<{ id: string }> };

/** Connects to the server, lists its tools, and caches the list for the agent builder. */
export const POST = route<Ctx>(async (_req, ctx) => {
  const account = await requireAccount();
  const row = getMcpRow(account.id, (await ctx.params).id);
  let error: string | null = null;
  try {
    const conn = await connectMcp(row);
    const tools = describeTools(conn.tools);
    await conn.close();
    recordMcpProbe(row.id, tools, `Connected: ${tools.length} tool${tools.length === 1 ? "" : "s"}`);
  } catch (err) {
    error = (err as Error).message;
    recordMcpProbe(row.id, null, `Failed: ${error}`);
  }
  return { server: listMcpServers(account.id).find((s) => s.id === row.id), error };
});
