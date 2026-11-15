import "server-only";
import { getDb, schema } from "@/db";
import { backoffDelay, isRetryableStatus, parseRetryAfter } from "@/lib/shared/retry";
import { ApiError } from "./api";
import { newId } from "./crypto";
import { env } from "./env";
import { assertWithinBudget } from "./settings";

/**
 * The single gateway to OpenRouter. Every upstream call in the app goes through
 * `fetchWithRetry`, which adds auth + attribution headers, retries transient failures
 * with backoff, and is paired with a request-log row.
 */

export type LogKind = "chat" | "responses" | "agent" | "eval" | "meta";

export interface CallMeta {
  accountId: string;
  kind: LogKind;
  model?: string | null;
  streamed?: boolean;
  refType?: "run" | "eval";
  refId?: string;
}

export interface Usage {
  promptTokens?: number | null;
  completionTokens?: number | null;
  reasoningTokens?: number | null;
  cachedTokens?: number | null;
  cost?: number | null;
}

export interface LogOutcome extends Usage {
  status?: number | null;
  ok: boolean;
  latencyMs?: number;
  ttftMs?: number | null;
  retries?: number;
  modelUsed?: string | null;
  provider?: string | null;
  generationId?: string | null;
  finishReason?: string | null;
  error?: string | null;
}

export function writeRequestLog(meta: CallMeta, endpoint: string, method: string, startedAt: number, o: LogOutcome) {
  try {
    getDb()
      .insert(schema.requestLogs)
      .values({
        id: newId("req"),
        accountId: meta.accountId,
        ts: startedAt,
        kind: meta.kind,
        endpoint,
        method,
        model: meta.model ?? null,
        modelUsed: o.modelUsed ?? null,
        provider: o.provider ?? null,
        status: o.status ?? null,
        ok: o.ok,
        streamed: meta.streamed ?? false,
        latencyMs: o.latencyMs ?? Date.now() - startedAt,
        ttftMs: o.ttftMs ?? null,
        retries: o.retries ?? 0,
        promptTokens: o.promptTokens ?? null,
        completionTokens: o.completionTokens ?? null,
        reasoningTokens: o.reasoningTokens ?? null,
        cachedTokens: o.cachedTokens ?? null,
        cost: o.cost ?? null,
        generationId: o.generationId ?? null,
        finishReason: o.finishReason ?? null,
        error: o.error ? o.error.slice(0, 2000) : null,
        refType: meta.refType ?? null,
        refId: meta.refId ?? null,
      })
      .run();
  } catch (err) {
    // Logging must never break the request it describes.
    console.error("[openrouter] failed to write request log", err);
  }
}

export function authHeaders(apiKey: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "HTTP-Referer": env.appUrl,
    "X-OpenRouter-Title": "OpenRouter Studio",
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface RetryResult {
  response: Response;
  retries: number;
}

/**
 * fetch() with retries on 408/429/5xx and network errors. Honors Retry-After, otherwise
 * backs off exponentially with jitter. Only the request is retried: once a response body
 * starts streaming it is handed to the caller as-is.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: { maxRetries?: number; onRetry?: (attempt: number, reason: string, delayMs: number) => void } = {},
): Promise<RetryResult> {
  const maxRetries = opts.maxRetries ?? env.maxRetries;
  let attempt = 0;
  for (;;) {
    let response: Response | null = null;
    let networkError: unknown = null;
    try {
      response = await fetch(url, init);
    } catch (err) {
      if (init.signal?.aborted) throw err;
      networkError = err;
    }

    if (response && !isRetryableStatus(response.status)) return { response, retries: attempt };
    if (attempt >= maxRetries) {
      if (response) return { response, retries: attempt };
      throw networkError;
    }

    const retryAfter = response ? parseRetryAfter(response.headers.get("retry-after")) : null;
    const delay = backoffDelay(attempt, retryAfter);
    const reason = response ? `HTTP ${response.status}` : `network error: ${(networkError as Error)?.message ?? networkError}`;
    // Drain the failed body so the connection can be reused.
    await response?.body?.cancel().catch(() => {});
    opts.onRetry?.(attempt + 1, reason, delay);
    await sleep(delay, init.signal);
    attempt++;
  }
}

export class UpstreamError extends ApiError {
  constructor(
    status: number,
    message: string,
    public upstream: { code?: number | string; metadata?: unknown; retries: number },
  ) {
    super(status, "upstream_error", message, upstream);
  }
}

/** Extracts OpenRouter's `{ error: { code, message, metadata } }` body from a failed response. */
export async function readUpstreamError(response: Response, retries: number): Promise<UpstreamError> {
  let message = `OpenRouter returned HTTP ${response.status}.`;
  let code: number | string | undefined;
  let metadata: unknown;
  try {
    const body = await response.json();
    const err = body?.error;
    if (typeof err === "string") message = err;
    else if (err?.message) {
      message = String(err.message);
      code = err.code;
      metadata = err.metadata;
    }
  } catch {
    /* non-JSON error body; keep the generic message */
  }
  // Never forward an upstream 401 as our own 401: that status means "no key connected" here.
  const status = response.status === 401 ? 502 : response.status;
  if (response.status === 401) message = `OpenRouter rejected the API key: ${message}`;
  return new UpstreamError(status, message, { code, metadata, retries });
}

export interface OrRequest {
  method?: "GET" | "POST" | "DELETE" | "PATCH";
  body?: unknown;
  signal?: AbortSignal | null;
  headers?: Record<string, string>;
  maxRetries?: number;
}

export interface OrCall {
  response: Response;
  retries: number;
  startedAt: number;
  /** Writes the request-log row. Call exactly once, when the outcome (incl. usage) is known. */
  finish(outcome: Omit<LogOutcome, "retries" | "status"> & { status?: number | null }): void;
}

/**
 * Low-level call: returns the raw Response (ok or not) plus a `finish` hook for logging.
 * Use this for streaming; use `orJson` when you just want parsed JSON.
 */
export async function orFetch(apiKey: string | null, path: string, req: OrRequest, meta: CallMeta): Promise<OrCall> {
  if (meta.kind !== "meta") assertWithinBudget(meta.accountId);
  const method = req.method ?? "GET";
  const startedAt = Date.now();
  let finished = false;
  const finishWith = (retries: number, status: number | null) => (outcome: Parameters<OrCall["finish"]>[0]) => {
    if (finished) return;
    finished = true;
    writeRequestLog(meta, path, method, startedAt, { status, retries, ...outcome });
  };

  try {
    const { response, retries } = await fetchWithRetry(
      `${env.openrouterBaseUrl}${path}`,
      {
        method,
        headers: {
          ...authHeaders(apiKey),
          ...(req.body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...req.headers,
        },
        body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
        signal: req.signal ?? undefined,
      },
      { maxRetries: req.maxRetries },
    );
    return { response, retries, startedAt, finish: finishWith(retries, response.status) };
  } catch (err) {
    const aborted = req.signal?.aborted;
    finishWith(env.maxRetries, null)({ ok: false, error: aborted ? "aborted" : `network error: ${(err as Error).message}` });
    if (aborted) throw err;
    throw new ApiError(502, "upstream_unreachable", `Could not reach OpenRouter: ${(err as Error).message}`);
  }
}

/** JSON request/response helper. Logs the call and throws UpstreamError on non-2xx. */
export async function orJson<T>(apiKey: string | null, path: string, req: OrRequest, meta: CallMeta): Promise<T> {
  const call = await orFetch(apiKey, path, req, meta);
  if (!call.response.ok) {
    const err = await readUpstreamError(call.response, call.retries);
    call.finish({ ok: false, error: err.message });
    throw err;
  }
  const data = (await call.response.json()) as T;
  call.finish({ ok: true, ...usageFromBody(data) });
  return data;
}

type AnyRecord = Record<string, unknown>;

/** Normalizes usage from either Chat Completions (snake_case) or Responses API bodies. */
export function normalizeUsage(usage: unknown): Usage {
  if (!usage || typeof usage !== "object") return {};
  const u = usage as AnyRecord;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const promptDetails = (u.prompt_tokens_details ?? u.input_tokens_details) as AnyRecord | undefined;
  const completionDetails = (u.completion_tokens_details ?? u.output_tokens_details) as AnyRecord | undefined;
  return {
    promptTokens: num(u.prompt_tokens ?? u.input_tokens),
    completionTokens: num(u.completion_tokens ?? u.output_tokens),
    reasoningTokens: num(completionDetails?.reasoning_tokens),
    cachedTokens: num(promptDetails?.cached_tokens),
    cost: num(u.cost),
  };
}

function usageFromBody(body: unknown): Partial<LogOutcome> {
  if (!body || typeof body !== "object") return {};
  const b = body as AnyRecord;
  if (!b.usage) return {};
  return {
    ...normalizeUsage(b.usage),
    modelUsed: typeof b.model === "string" ? b.model : null,
    provider: typeof b.provider === "string" ? b.provider : null,
    generationId: typeof b.id === "string" ? b.id : null,
  };
}
