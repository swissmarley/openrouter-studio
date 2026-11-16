import { route } from "@/lib/server/api";
import { listProviders } from "@/lib/server/models";
import { getAccount } from "@/lib/server/session";

export const GET = route(async () => {
  const account = await getAccount();
  return { providers: await listProviders(account?.id ?? "anon", account?.apiKey() || null) };
});
