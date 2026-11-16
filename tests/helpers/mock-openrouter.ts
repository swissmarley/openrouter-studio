import http from "node:http";
import type { AddressInfo } from "node:net";

export interface Recorded {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

type Reply =
  | { status: number; json: unknown; headers?: Record<string, string> }
  | { status?: number; sse: string[]; headers?: Record<string, string>; delayMs?: number }
  | ((req: Recorded) => Reply);

/**
 * A scriptable stand-in for the OpenRouter API. Each call to a path consumes the next
 * queued reply; the last reply for a path repeats. Lets tests cover failure modes that
 * cannot be produced on demand against the real service (429s, 5xx, mid-stream errors).
 */
export class MockOpenRouter {
  requests: Recorded[] = [];
  private queues = new Map<string, Reply[]>();
  private server = http.createServer((req, res) => void this.handle(req, res));

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  stop(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  reset() {
    this.requests = [];
    this.queues.clear();
  }

  on(path: string, ...replies: Reply[]) {
    this.queues.set(path, replies);
    return this;
  }

  calls(path: string): Recorded[] {
    return this.requests.filter((r) => r.path === path);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body: unknown = raw;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      /* keep raw text */
    }
    const path = (req.url ?? "/").split("?")[0];
    const recorded: Recorded = { method: req.method ?? "GET", path, headers: req.headers, body };
    this.requests.push(recorded);

    const queue = this.queues.get(path);
    if (!queue?.length) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: 404, message: `mock: no reply queued for ${path}` } }));
      return;
    }
    const next = queue.length > 1 ? queue.shift()! : queue[0];
    const reply = typeof next === "function" ? next(recorded) : next;
    if (typeof reply === "function") throw new Error("nested reply functions are not supported");

    if ("sse" in reply) {
      // An optional pause before the first byte, to give tests time to pause or cancel.
      if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
      if (res.destroyed) return;
      res.writeHead(reply.status ?? 200, { "content-type": "text/event-stream", ...reply.headers });
      for (const frame of reply.sse) {
        res.write(frame);
        await new Promise((r) => setTimeout(r, 2));
      }
      res.end();
    } else {
      res.writeHead(reply.status, { "content-type": "application/json", ...reply.headers });
      res.end(JSON.stringify(reply.json));
    }
  }
}

/** One `data:` frame. */
export const data = (payload: unknown) => `data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`;
