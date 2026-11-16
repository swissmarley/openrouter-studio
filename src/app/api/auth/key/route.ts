import { z } from "zod";
import { ApiError, parseBody, route } from "@/lib/server/api";
import { fetchKeyInfo } from "@/lib/server/keyinfo";
import { UpstreamError } from "@/lib/server/openrouter";
import { signInWithKey, signOut } from "@/lib/server/session";

const bodySchema = z.object({
  apiKey: z
    .string()
    .trim()
    .min(8, "That does not look like an OpenRouter key.")
    .max(512)
    .regex(/^\S+$/, "Keys cannot contain whitespace."),
});

/** Connect a pasted key. It is verified against OpenRouter before anything is stored. */
export const POST = route(async (req) => {
  const { apiKey } = await parseBody(req, bodySchema);
  let info;
  try {
    info = await fetchKeyInfo("anon", apiKey);
  } catch (err) {
    if (err instanceof UpstreamError) {
      throw new ApiError(400, "invalid_key", err.message.replace(/^OpenRouter rejected the API key: /, "OpenRouter rejected this key: "));
    }
    throw err;
  }
  const account = await signInWithKey(apiKey, "paste");
  return { connected: true, keyHint: account.keyHint, source: account.source, key: info };
});

/** Disconnect. `?forget=1` also destroys the stored key. */
export const DELETE = route(async (req) => {
  await signOut(new URL(req.url).searchParams.get("forget") === "1");
  return { connected: false };
});
