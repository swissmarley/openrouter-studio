import "server-only";
import { unstable_rethrow } from "next/navigation";
import { connection } from "next/server";
import { z } from "zod";

/** An error with an HTTP status that is safe to show to the client. */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}

export function errorResponse(err: unknown): Response {
  if (err instanceof ApiError) {
    return json({ error: { code: err.code, message: err.message, details: err.details } }, { status: err.status });
  }
  if (err instanceof z.ZodError) {
    return json(
      { error: { code: "invalid_input", message: "Invalid input.", details: z.flattenError(err) } },
      { status: 400 },
    );
  }
  console.error("[api] unhandled error", err);
  return json({ error: { code: "internal", message: "Internal server error." } }, { status: 500 });
}

/**
 * Cookie-authenticated mutations must come from our own origin. Browsers always send
 * Origin on cross-site POSTs, so a mismatch is a CSRF attempt; non-browser clients omit it.
 */
function assertSameOrigin(req: Request) {
  if (req.method === "GET" || req.method === "HEAD") return;
  const origin = req.headers.get("origin");
  if (!origin) return;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  let originHost: string | null = null;
  try {
    originHost = new URL(origin).host;
  } catch {
    /* fall through to rejection */
  }
  if (!originHost || originHost !== host) {
    throw new ApiError(403, "bad_origin", "Cross-origin request rejected.");
  }
}

type Handler<C> = (req: Request, ctx: C) => Promise<Response | unknown>;

/** Wraps a route handler with origin checking and uniform error responses. */
export function route<C = unknown>(handler: Handler<C>) {
  return async (req: Request, ctx: C): Promise<Response> => {
    try {
      // Every API route is per-request: never prerendered at build time, never cached.
      await connection();
      assertSameOrigin(req);
      const result = await handler(req, ctx);
      return result instanceof Response ? result : json(result ?? { ok: true });
    } catch (err) {
      // Next.js signals "this needs a real request" (e.g. cookies() during build-time
      // prerendering) by throwing; that must reach the framework, not become a 500.
      unstable_rethrow(err);
      return errorResponse(err);
    }
  };
}

export async function parseBody<S extends z.ZodType>(req: Request, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new ApiError(400, "invalid_json", "Request body must be valid JSON.");
  }
  return schema.parse(raw);
}

export function parseQuery<S extends z.ZodType>(req: Request, schema: S): z.infer<S> {
  const params = Object.fromEntries(new URL(req.url).searchParams.entries());
  return schema.parse(params);
}
