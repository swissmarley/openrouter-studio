import examples from "../../../../../examples/agents.json";
import { route } from "@/lib/server/api";
import { importBundle } from "@/lib/server/agents/store";
import { requireAccount } from "@/lib/server/session";
import { bundleSchema } from "@/lib/shared/bundle";

/** Installs the bundled example agents (the same file that ships in /examples). */
export const POST = route(async () => {
  const account = await requireAccount();
  return { report: importBundle(account.id, bundleSchema.parse(examples)) };
});
