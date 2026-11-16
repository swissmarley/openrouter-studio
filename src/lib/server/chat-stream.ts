import "server-only";
import { createParser, type EventSourceMessage } from "eventsource-parser";
import {
  buildChatCompletionsBody,
  buildResponsesBody,
  type ChatRequest,
  type ChatStreamEvent,
  type ChatUsage,
} from "@/lib/shared/chat";
import { normalizeUsage, orFetch, readUpstreamError, type CallMeta, type Usage } from "./openrouter";

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null;
const str = (v: unknown) => (typeof v === "string" ? v : null);

/** What one upstream SSE payload means, independent of which API produced it. */
interface Parsed {
  text?: string;
  reasoning?: string;
  usage?: Usage;
  model?: string | null;
  provider?: string | null;
  generationId?: string | null;
  finishReason?: string | null;
  error?: { message: string; code?: number | string };
}

function errorOf(e: unknown): Parsed["error"] {
  if (!isRec(e)) return { message: "The provider returned an error." };
  return { message: str(e.message) ?? "The provider returned an error.", code: e.code as number | string | undefined };
}

/** Chat Completions chunk: text in choices[].delta.content, reasoning in delta.reasoning(_details). */
function parseChatChunk(d: Rec): Parsed {
  const out: Parsed = { model: str(d.model), provider: str(d.provider), generationId: str(d.id) };
  // Mid-stream failures arrive as a normal chunk carrying a top-level `error`.
  if (d.error) out.error = errorOf(d.error);
  const choice = Array.isArray(d.choices) ? (d.choices[0] as Rec | undefined) : undefined;
  const delta = isRec(choice?.delta) ? choice.delta : undefined;
  if (delta) {
    if (typeof delta.content === "string" && delta.content) out.text = delta.content;
    if (typeof delta.reasoning === "string" && delta.reasoning) {
      out.reasoning = delta.reasoning;
    } else if (Array.isArray(delta.reasoning_details)) {
      const text = delta.reasoning_details
        .map((r) => (isRec(r) ? (str(r.text) ?? str(r.summary) ?? "") : ""))
        .join("");
      if (text) out.reasoning = text;
    }
  }
  if (choice && str(choice.finish_reason)) out.finishReason = str(choice.finish_reason);
  if (d.usage) out.usage = normalizeUsage(d.usage);
  return out;
}

/** Responses API event: typed events, with usage on the terminal `response.completed`. */
function parseResponsesEvent(d: Rec): Parsed {
  const type = str(d.type) ?? "";
  if (type === "response.output_text.delta" && typeof d.delta === "string") return { text: d.delta };
  if (/^response\.reasoning.*\.delta$/.test(type) && typeof d.delta === "string") return { reasoning: d.delta };
  if (type === "error") return { error: errorOf(d.error ?? d) };

  const response = isRec(d.response) ? d.response : undefined;
  if (!response) return {};
  const base: Parsed = { model: str(response.model), generationId: str(response.id) };
  if (type === "response.failed") return { ...base, error: errorOf(response.error) };
  if (type === "response.incomplete") {
    const reason = isRec(response.incomplete_details) ? str(response.incomplete_details.reason) : null;
    return { ...base, finishReason: reason === "max_output_tokens" ? "length" : (reason ?? "incomplete"), usage: normalizeUsage(response.usage) };
  }
  if (type === "response.completed") return { ...base, finishReason: "stop", usage: normalizeUsage(response.usage) };
  return base;
}

/** Splits a byte stream into SSE messages. Comment lines (": OPENROUTER PROCESSING") are dropped by the parser. */
async function* sseMessages(body: ReadableStream<Uint8Array>): AsyncGenerator<EventSourceMessage> {
  const queue: EventSourceMessage[] = [];
  const parser = createParser({ onEvent: (e) => queue.push(e) });
  const decoder = new TextDecoder();
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.feed(decoder.decode(value, { stream: true }));
      while (queue.length) yield queue.shift()!;
    }
  } finally {
    reader.releaseLock();
  }
}

export interface OpenChatOptions {
  apiKey: string;
  meta: Omit<CallMeta, "model" | "streamed">;
  signal?: AbortSignal;
}

/**
 * Starts a streaming completion. Failures before the first byte throw (so callers can
 * return a real HTTP status); after that everything, including mid-stream provider
 * errors, is reported as events. A `usage` event is always emitted before `done`.
 */
export async function openChat(req: ChatRequest, opts: OpenChatOptions): Promise<AsyncGenerator<ChatStreamEvent>> {
  const path = req.api === "responses" ? "/responses" : "/chat/completions";
  const body = req.api === "responses" ? buildResponsesBody(req) : buildChatCompletionsBody(req);
  const call = await orFetch(
    opts.apiKey,
    path,
    { method: "POST", body, signal: opts.signal },
    { ...opts.meta, model: req.model, streamed: true },
  );

  if (!call.response.ok || !call.response.body) {
    const err = await readUpstreamError(call.response, call.retries);
    call.finish({ ok: false, error: err.message });
    throw err;
  }

  const upstream = call.response.body;
  const parse = req.api === "responses" ? parseResponsesEvent : parseChatChunk;

  return (async function* () {
    const usage: ChatUsage = {
      promptTokens: null,
      completionTokens: null,
      reasoningTokens: null,
      cachedTokens: null,
      cost: null,
      model: null,
      provider: null,
      generationId: null,
      finishReason: null,
      latencyMs: 0,
      ttftMs: null,
      retries: call.retries,
    };
    let failure: string | null = null;
    let completed = false;

    try {
      for await (const msg of sseMessages(upstream)) {
        if (msg.data === "[DONE]") break;
        let data: unknown;
        try {
          data = JSON.parse(msg.data);
        } catch {
          continue;
        }
        if (!isRec(data)) continue;
        const p = parse(data);

        if (p.model) usage.model = p.model;
        if (p.provider) usage.provider = p.provider;
        if (p.generationId) usage.generationId = p.generationId;
        if (p.finishReason) usage.finishReason = p.finishReason;
        if (p.usage) Object.assign(usage, p.usage);

        if ((p.text || p.reasoning) && usage.ttftMs === null) usage.ttftMs = Date.now() - call.startedAt;
        if (p.reasoning) yield { type: "reasoning", text: p.reasoning };
        if (p.text) yield { type: "delta", text: p.text };
        if (p.error) {
          failure = p.error.message;
          usage.finishReason = "error";
          yield { type: "error", message: p.error.message, code: p.error.code };
        }
      }
      usage.latencyMs = Date.now() - call.startedAt;
      yield { type: "usage", usage };
      completed = true;
      yield { type: "done" };
    } catch (err) {
      failure = opts.signal?.aborted ? "aborted" : `stream error: ${(err as Error).message}`;
      throw err;
    } finally {
      // Runs on normal completion, on error, and when the consumer stops early (client
      // disconnect or Stop). An abandoned stream is not a success, so say so in the log.
      if (!completed && failure === null) failure = "aborted";
      usage.latencyMs ||= Date.now() - call.startedAt;
      call.finish({
        ok: failure === null,
        error: failure,
        latencyMs: usage.latencyMs,
        ttftMs: usage.ttftMs,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        reasoningTokens: usage.reasoningTokens,
        cachedTokens: usage.cachedTokens,
        cost: usage.cost,
        modelUsed: usage.model,
        provider: usage.provider,
        generationId: usage.generationId,
        finishReason: usage.finishReason,
      });
    }
  })();
}

export interface ChatResult {
  text: string;
  reasoning: string;
  usage: ChatUsage | null;
  error: string | null;
}

/** Runs a completion to the end and returns the collected result (used by evals). */
export async function collectChat(req: ChatRequest, opts: OpenChatOptions): Promise<ChatResult> {
  const result: ChatResult = { text: "", reasoning: "", usage: null, error: null };
  for await (const event of await openChat(req, opts)) {
    if (event.type === "delta") result.text += event.text;
    else if (event.type === "reasoning") result.reasoning += event.text;
    else if (event.type === "usage") result.usage = event.usage;
    else if (event.type === "error") result.error = event.message;
  }
  return result;
}
