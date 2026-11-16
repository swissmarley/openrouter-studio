import { z } from "zod";
import { parseQuery, route } from "@/lib/server/api";
import { exportBundle } from "@/lib/server/agents/store";
import { requireAccount } from "@/lib/server/session";

const querySchema = z.object({ ids: z.string().max(4000).optional() });

/** Downloads agents (plus the custom tools they use) as a portable JSON bundle. */
export const GET = route(async (req) => {
  const account = await requireAccount();
  const { ids } = parseQuery(req, querySchema);
  const bundle = exportBundle(account.id, ids ? ids.split(",").filter(Boolean) : undefined);
  return new Response(JSON.stringify(bundle, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="openrouter-studio-agents-${new Date().toISOString().slice(0, 10)}.json"`,
    },
  });
});
