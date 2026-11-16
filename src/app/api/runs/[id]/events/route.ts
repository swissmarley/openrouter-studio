import { unstable_rethrow } from "next/navigation";
import { connection } from "next/server";
import { z } from "zod";
import { errorResponse, parseQuery } from "@/lib/server/api";
import { getController, getRunRow, listEvents } from "@/lib/server/agents/runner";
import { requireAccount } from "@/lib/server/session";
import { SSE_HEADERS, sseFrame } from "@/lib/server/sse";
import type { RunEvent } from "@/lib/shared/runs";

const querySchema = z.object({ after: z.coerce.number().int().min(0).default(0) });
const encoder = new TextEncoder();

/**
 * Live trace. Sends every stored event after `?after=<seq>`, then follows the run until
 * it finishes. A client that loses the connection reconnects with the last seq it saw
 * and misses nothing.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let runId: string;
  let after: number;
  try {
    await connection();
    const account = await requireAccount();
    runId = getRunRow(account.id, (await ctx.params).id).id;
    after = parseQuery(req, querySchema).after;
  } catch (err) {
    unstable_rethrow(err);
    return errorResponse(err);
  }

  let unsubscribe: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const cleanup = () => {
    unsubscribe?.();
    clearInterval(heartbeat);
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        cleanup();
        try {
          controller.close();
        } catch {
          /* already closed by the client */
        }
      };
      const send = (event: RunEvent) => {
        if (closed) return;
        controller.enqueue(sseFrame(event.type, event, event.type === "delta" ? undefined : event.seq));
        if (event.type === "run.finished") close();
      };

      // Read the backlog and attach to the live run in the same tick: emit() is
      // synchronous, so no event can fall between the two.
      const backlog = listEvents(runId, after);
      const live = getController(runId);
      if (live) unsubscribe = live.subscribe(send);
      backlog.forEach(send);
      if (!live) return close();

      heartbeat = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode(": keep-alive\n\n"));
      }, 15_000);
      req.signal.addEventListener("abort", close, { once: true });
    },
    cancel: cleanup,
  });
  return new Response(stream, { headers: SSE_HEADERS });
}
