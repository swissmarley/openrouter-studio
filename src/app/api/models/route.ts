import { route } from "@/lib/server/api";
import { listModels } from "@/lib/server/models";
import { getAccount } from "@/lib/server/session";

/** Live model catalog. Public upstream, so it also works before a key is connected. */
export const GET = route(async (req) => {
  const account = await getAccount();
  const refresh = new URL(req.url).searchParams.get("refresh") === "1";
  const models = await listModels(account?.id ?? "anon", account?.apiKey() || null, refresh);
  return { models, fetchedAt: Date.now() };
});
