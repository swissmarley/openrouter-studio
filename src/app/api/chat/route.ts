import { parseBody, route } from "@/lib/server/api";
import { openChat } from "@/lib/server/chat-stream";
import { requireAccount } from "@/lib/server/session";
import { sseResponse } from "@/lib/server/sse";
import { chatRequestSchema } from "@/lib/shared/chat";

/**
 * Streaming chat proxy. The browser sends our own request shape; the server builds the
 * OpenRouter body (Chat Completions or Responses), attaches the key, and relays a
 * normalized event stream. Aborting the request aborts the upstream call, which stops
 * generation (and billing) on providers that support it.
 */
export const POST = route(async (req) => {
  const account = await requireAccount();
  const body = await parseBody(req, chatRequestSchema);

  const abort = new AbortController();
  req.signal.addEventListener("abort", () => abort.abort(), { once: true });

  const events = await openChat(body, {
    apiKey: account.apiKey(),
    meta: { accountId: account.id, kind: body.api === "responses" ? "responses" : "chat" },
    signal: abort.signal,
  });
  return sseResponse(events, () => abort.abort());
});
