import "server-only";

const encoder = new TextEncoder();

export function sseFrame(event: string, data: unknown, id?: number | string): Uint8Array {
  return encoder.encode(`${id !== undefined ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

const HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  // Tell reverse proxies (nginx) not to buffer, or tokens arrive in one lump.
  "X-Accel-Buffering": "no",
};

/**
 * Streams `{ type, ... }` events as Server-Sent Events. When the client goes away the
 * source generator is closed and `onCancel` fires, so upstream work stops with it.
 */
export function sseResponse<T extends { type: string }>(source: AsyncGenerator<T>, onCancel?: () => void): Response {
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await source.next();
        if (closed) return;
        if (done) {
          closed = true;
          controller.close();
          return;
        }
        controller.enqueue(sseFrame(value.type, value));
      } catch (err) {
        if (closed) return;
        closed = true;
        controller.enqueue(sseFrame("error", { type: "error", message: (err as Error).message ?? "Stream failed." }));
        controller.close();
      }
    },
    async cancel() {
      closed = true;
      onCancel?.();
      await source.return(undefined).catch(() => {});
    },
  });
  return new Response(stream, { headers: HEADERS });
}

export { HEADERS as SSE_HEADERS };
