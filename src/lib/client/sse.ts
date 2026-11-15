"use client";

import { createParser } from "eventsource-parser";
import { ApiClientError } from "./api";

/**
 * POSTs JSON and reads the Server-Sent Events reply. EventSource cannot POST or send a
 * body, so this reads the fetch stream directly. A non-2xx reply is thrown as an
 * ApiClientError, exactly as the JSON helpers do.
 */
export async function postSse<E extends { type: string }>(
  url: string,
  body: unknown,
  onEvent: (event: E) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(body),
    signal,
  });
  await readSse(res, onEvent);
}

export async function readSse<E extends { type: string }>(res: Response, onEvent: (event: E) => void): Promise<void> {
  if (!res.ok || !res.body) {
    let err: { code?: string; message?: string; details?: unknown } | undefined;
    try {
      err = (await res.json())?.error;
    } catch {
      /* not JSON */
    }
    throw new ApiClientError(res.status, err?.code ?? "error", err?.message ?? `Request failed (${res.status}).`, err?.details);
  }
  const parser = createParser({
    onEvent: (msg) => {
      try {
        onEvent(JSON.parse(msg.data) as E);
      } catch {
        /* skip malformed frames rather than killing the stream */
      }
    },
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parser.feed(decoder.decode(value, { stream: true }));
  }
}
