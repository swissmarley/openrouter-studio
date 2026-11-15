import { route } from "@/lib/server/api";
import { fetchKeyInfo } from "@/lib/server/keyinfo";
import { getAccount } from "@/lib/server/session";

export const GET = route(async () => {
  const account = await getAccount();
  if (!account) return { connected: false };
  let key = null;
  let keyError: string | null = null;
  try {
    key = await fetchKeyInfo(account.id, account.apiKey());
  } catch (err) {
    keyError = (err as Error).message;
  }
  return { connected: true, keyHint: account.keyHint, source: account.source, key, keyError };
});
