import { parseBody, route } from "@/lib/server/api";
import { requireAccount } from "@/lib/server/session";
import { getBudgetStatus, getSettings, saveSettings } from "@/lib/server/settings";
import { settingsSchema } from "@/lib/shared/settings";

export const GET = route(async () => {
  const account = await requireAccount();
  const settings = getSettings(account.id);
  return { settings, budget: getBudgetStatus(account.id, settings) };
});

export const PUT = route(async (req) => {
  const account = await requireAccount();
  const settings = saveSettings(account.id, await parseBody(req, settingsSchema));
  return { settings, budget: getBudgetStatus(account.id, settings) };
});
