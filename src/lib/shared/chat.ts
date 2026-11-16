import { z } from "zod";
import { isAutoRouter, routingSchema, toModelFields, toProviderPrefs, type Routing } from "./routing";

/** Request contract between the playground and POST /api/chat, plus upstream body builders. */

// ~20 MB of base64 per attachment; the upstream limit depends on the model.
const MAX_ATTACHMENT_CHARS = 28_000_000;

const textPart = z.object({ type: z.literal("text"), text: z.string().max(2_000_000) });
const imagePart = z.object({
  type: z.literal("image"),
  /** An https URL or a data: URL. */
  url: z.string().max(MAX_ATTACHMENT_CHARS).regex(/^(https:\/\/|data:image\/)/, "Images must be https or data URLs."),
});
const filePart = z.object({
  type: z.literal("file"),
  filename: z.string().min(1).max(300),
  /** A data: URL (application/pdf) or an https URL. */
  data: z.string().max(MAX_ATTACHMENT_CHARS).regex(/^(https:\/\/|data:)/, "Files must be https or data URLs."),
});
const audioPart = z.object({
  type: z.literal("audio"),
  /** Raw base64, no data: prefix (OpenRouter does not accept audio URLs). */
  data: z.string().max(MAX_ATTACHMENT_CHARS).regex(/^[A-Za-z0-9+/=]+$/, "Audio must be base64."),
  format: z.enum(["wav", "mp3", "aiff", "aac", "ogg", "flac", "m4a", "pcm16", "pcm24"]),
});

export const contentPartSchema = z.discriminatedUnion("type", [textPart, imagePart, filePart, audioPart]);
export type ContentPart = z.infer<typeof contentPartSchema>;

export const chatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.union([z.string().max(2_000_000), z.array(contentPartSchema).min(1).max(40)]),
});
export type ChatMessageInput = z.infer<typeof chatMessageSchema>;

export const REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

export const samplingSchema = z.object({
  temperature: z.number().min(0).max(2).nullable().default(null),
  topP: z.number().min(0).max(1).nullable().default(null),
  topK: z.number().int().min(0).max(1000).nullable().default(null),
  maxTokens: z.number().int().min(1).max(1_000_000).nullable().default(null),
  frequencyPenalty: z.number().min(-2).max(2).nullable().default(null),
  presencePenalty: z.number().min(-2).max(2).nullable().default(null),
  seed: z.number().int().min(0).max(2 ** 31 - 1).nullable().default(null),
  stop: z.array(z.string().min(1).max(200)).max(4).default([]),
});
export type Sampling = z.infer<typeof samplingSchema>;

export const reasoningSchema = z.object({
  /** "default" leaves the decision to the model; "on"/"off" set reasoning.enabled explicitly. */
  mode: z.enum(["default", "on", "off"]).default("default"),
  effort: z.enum(REASONING_EFFORTS).nullable().default(null),
  maxTokens: z.number().int().min(1).max(1_000_000).nullable().default(null),
  /** Chat Completions only: reason, but leave the reasoning out of the response. */
  exclude: z.boolean().default(false),
});
export type ReasoningConfig = z.infer<typeof reasoningSchema>;

export const responseFormatSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text") }),
  z.object({ type: z.literal("json_object") }),
  z.object({
    type: z.literal("json_schema"),
    name: z.string().regex(/^[\w-]{1,64}$/, "Use letters, digits, _ and - only."),
    strict: z.boolean().default(true),
    schema: z.record(z.string(), z.unknown()),
  }),
]);
export type ResponseFormat = z.infer<typeof responseFormatSchema>;

export const chatRequestSchema = z.object({
  api: z.enum(["chat", "responses"]).default("chat"),
  model: z.string().trim().min(1).max(200),
  system: z.string().max(500_000).default(""),
  messages: z.array(chatMessageSchema).min(1).max(400),
  sampling: samplingSchema.prefault({}),
  reasoning: reasoningSchema.prefault({}),
  responseFormat: responseFormatSchema.default({ type: "text" }),
  routing: routingSchema.prefault({}),
  pdfEngine: z.enum(["auto", "native", "mistral-ocr", "cloudflare-ai"]).default("auto"),
});
export type ChatRequest = z.infer<typeof chatRequestSchema>;
export type ChatRequestInput = z.input<typeof chatRequestSchema>;

type Body = Record<string, unknown>;

function plugins(req: Pick<ChatRequest, "pdfEngine" | "model" | "routing">): Body[] | undefined {
  const out: Body[] = [];
  if (req.pdfEngine !== "auto") out.push({ id: "file-parser", pdf: { engine: req.pdfEngine } });
  if (isAutoRouter(req.model) && req.routing.autoAllowedModels.length) {
    out.push({ id: "auto-router", allowed_models: req.routing.autoAllowedModels });
  }
  return out.length ? out : undefined;
}

function reasoningBody(r: ReasoningConfig, api: "chat" | "responses"): Body | undefined {
  const out: Body = {};
  if (r.mode === "off") out.enabled = false;
  else {
    if (r.mode === "on") out.enabled = true;
    if (r.effort) out.effort = r.effort;
    if (r.maxTokens !== null) out.max_tokens = r.maxTokens;
    if (r.exclude && api === "chat") out.exclude = true;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Drops undefined values so we only send parameters the user actually set. */
function compact(body: Body): Body {
  return Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined && v !== null));
}

function shared(req: ChatRequest, routing: Routing): Body {
  return {
    ...toModelFields(req.model, routing),
    stream: true,
    temperature: req.sampling.temperature,
    top_p: req.sampling.topP,
    top_k: req.sampling.topK,
    frequency_penalty: req.sampling.frequencyPenalty,
    presence_penalty: req.sampling.presencePenalty,
    provider: toProviderPrefs(routing),
    plugins: plugins(req),
  };
}

function chatPart(p: ContentPart): Body {
  switch (p.type) {
    case "text":
      return { type: "text", text: p.text };
    case "image":
      return { type: "image_url", image_url: { url: p.url } };
    case "file":
      return { type: "file", file: { filename: p.filename, file_data: p.data } };
    case "audio":
      return { type: "input_audio", input_audio: { data: p.data, format: p.format } };
  }
}

/** Body for POST /chat/completions. */
export function buildChatCompletionsBody(req: ChatRequest): Body {
  const messages: Body[] = [];
  if (req.system.trim()) messages.push({ role: "system", content: req.system });
  for (const m of req.messages) {
    messages.push({ role: m.role, content: typeof m.content === "string" ? m.content : m.content.map(chatPart) });
  }
  const rf = req.responseFormat;
  return compact({
    ...shared(req, req.routing),
    messages,
    max_tokens: req.sampling.maxTokens,
    seed: req.sampling.seed,
    stop: req.sampling.stop.length ? req.sampling.stop : undefined,
    reasoning: reasoningBody(req.reasoning, "chat"),
    response_format:
      rf.type === "text"
        ? undefined
        : rf.type === "json_object"
          ? { type: "json_object" }
          : { type: "json_schema", json_schema: { name: rf.name, strict: rf.strict, schema: rf.schema } },
  });
}

function responsesPart(p: ContentPart, role: "user" | "assistant"): Body {
  switch (p.type) {
    case "text":
      return role === "assistant" ? { type: "output_text", text: p.text, annotations: [] } : { type: "input_text", text: p.text };
    case "image":
      return { type: "input_image", image_url: p.url, detail: "auto" };
    case "file":
      return p.data.startsWith("https://")
        ? { type: "input_file", filename: p.filename, file_url: p.data }
        : { type: "input_file", filename: p.filename, file_data: p.data };
    case "audio":
      return { type: "input_audio", input_audio: { data: p.data, format: p.format } };
  }
}

/** Body for POST /responses. */
export function buildResponsesBody(req: ChatRequest): Body {
  const input = req.messages.map((m) => {
    const parts: ContentPart[] = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
    return { type: "message", role: m.role, content: parts.map((p) => responsesPart(p, m.role)) };
  });
  const rf = req.responseFormat;
  return compact({
    ...shared(req, req.routing),
    input,
    instructions: req.system.trim() ? req.system : undefined,
    max_output_tokens: req.sampling.maxTokens,
    reasoning: reasoningBody(req.reasoning, "responses"),
    text:
      rf.type === "text"
        ? undefined
        : rf.type === "json_object"
          ? { format: { type: "json_object" } }
          : { format: { type: "json_schema", name: rf.name, strict: rf.strict, schema: rf.schema } },
  });
}

/** Events the server emits to the browser, whichever upstream API produced them. */
export type ChatStreamEvent =
  | { type: "delta"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "usage"; usage: ChatUsage }
  | { type: "error"; message: string; code?: number | string }
  | { type: "done" };

export interface ChatUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  reasoningTokens: number | null;
  cachedTokens: number | null;
  cost: number | null;
  /** The model that actually answered (differs from the request under fallbacks or auto). */
  model: string | null;
  provider: string | null;
  generationId: string | null;
  finishReason: string | null;
  latencyMs: number;
  ttftMs: number | null;
  retries: number;
}
