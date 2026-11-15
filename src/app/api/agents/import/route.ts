import { parseBody, route } from "@/lib/server/api";
import { importBundle } from "@/lib/server/agents/store";
import { requireAccount } from "@/lib/server/session";
import { bundleSchema } from "@/lib/shared/bundle";

export const POST = route(async (req) => {
  const account = await requireAccount();
  return { report: importBundle(account.id, await parseBody(req, bundleSchema)) };
});
