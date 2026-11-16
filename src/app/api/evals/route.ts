import { parseBody, route } from "@/lib/server/api";
import { listEvals, startEval } from "@/lib/server/evals";
import { requireAccount } from "@/lib/server/session";
import { evalConfigSchema } from "@/lib/shared/evals";

export const GET = route(async () => {
  const account = await requireAccount();
  return { evals: listEvals(account.id) };
});

/** Starts an eval in the background; poll GET /api/evals/:id for progress. */
export const POST = route(async (req) => {
  const account = await requireAccount();
  return { id: startEval(account.id, account.apiKey(), await parseBody(req, evalConfigSchema)) };
});
