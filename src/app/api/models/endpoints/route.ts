import { z } from "zod";
import { parseQuery, route } from "@/lib/server/api";
import { listEndpoints } from "@/lib/server/models";
import { getAccount } from "@/lib/server/session";

const querySchema = z.object({
  id: z.string().min(3).max(200).regex(/^~?[\w.-]+\/[\w.:-]+$/, "Expected a model id like author/slug."),
});

export const GET = route(async (req) => {
  const { id } = parseQuery(req, querySchema);
  const account = await getAccount();
  const endpoints = await listEndpoints(account?.id ?? "anon", account?.apiKey() || null, id);
  return { endpoints };
});
