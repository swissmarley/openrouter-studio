import { route } from "@/lib/server/api";
import { requireAccount } from "@/lib/server/session";
import { getBudgetStatus } from "@/lib/server/settings";

export const GET = route(async () => {
  const account = await requireAccount();
  return getBudgetStatus(account.id);
});
