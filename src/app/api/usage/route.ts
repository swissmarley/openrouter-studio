import { route } from "@/lib/server/api";
import { fetchKeyInfo } from "@/lib/server/keyinfo";
import { requireAccount } from "@/lib/server/session";
import { getBudgetStatus } from "@/lib/server/settings";
import { fetchActivity, fetchCredits, localUsage } from "@/lib/server/usage";

/** Everything the dashboard shows, in one request. */
export const GET = route(async () => {
  const account = await requireAccount();
  const apiKey = account.apiKey();
  const [key, credits, activity] = await Promise.all([
    fetchKeyInfo(account.id, apiKey).then(
      (data) => ({ data, unavailable: null }),
      (err: Error) => ({ data: null, unavailable: err.message }),
    ),
    fetchCredits(account.id, apiKey),
    fetchActivity(account.id, apiKey),
  ]);
  return { key, credits, activity, local: localUsage(account.id), budget: getBudgetStatus(account.id) };
});
