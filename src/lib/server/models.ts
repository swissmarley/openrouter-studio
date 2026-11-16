import "server-only";
import type { EndpointInfo, ModelInfo, ProviderInfo } from "@/lib/shared/models";
import { orJson } from "./openrouter";

type Raw = Record<string, unknown>;

const TTL_MS = 5 * 60 * 1000;
const cache = globalThis as unknown as {
  __orsModels?: { at: number; data: ModelInfo[] };
  __orsProviders?: { at: number; data: ProviderInfo[] };
};

/** OpenRouter sends prices as decimal strings; -1 means "varies" (router models). */
function price(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function normalizeModel(m: Raw): ModelInfo {
  const arch = (m.architecture ?? {}) as Raw;
  const pricing = (m.pricing ?? {}) as Raw;
  const top = (m.top_provider ?? {}) as Raw;
  const reasoning = m.reasoning as Raw | undefined;
  const alias = m.alias_target as Raw | undefined;
  const id = String(m.id);
  return {
    id,
    name: String(m.name ?? id),
    author: id.replace(/^~/, "").split("/")[0],
    description: String(m.description ?? ""),
    created: Number(m.created ?? 0),
    contextLength: Number(m.context_length ?? top.context_length ?? 0),
    maxCompletionTokens: typeof top.max_completion_tokens === "number" ? top.max_completion_tokens : null,
    inputModalities: strings(arch.input_modalities),
    outputModalities: strings(arch.output_modalities),
    tokenizer: typeof arch.tokenizer === "string" ? arch.tokenizer : null,
    moderated: top.is_moderated === true,
    pricing: {
      prompt: price(pricing.prompt) ?? 0,
      completion: price(pricing.completion) ?? 0,
      image: price(pricing.image),
      request: price(pricing.request),
      cacheRead: price(pricing.input_cache_read),
      cacheWrite: price(pricing.input_cache_write),
      webSearch: price(pricing.web_search),
      internalReasoning: price(pricing.internal_reasoning),
    },
    supportedParameters: strings(m.supported_parameters),
    reasoning: reasoning
      ? {
          mandatory: reasoning.mandatory === true,
          defaultEnabled: reasoning.default_enabled === true,
          supportedEfforts: Array.isArray(reasoning.supported_efforts) ? strings(reasoning.supported_efforts) : null,
          defaultEffort: typeof reasoning.default_effort === "string" ? reasoning.default_effort : null,
          supportsMaxTokens: reasoning.supports_max_tokens === true,
        }
      : null,
    aliasOf: alias && typeof alias.slug === "string" ? alias.slug : null,
    expiresAt: typeof m.expiration_date === "string" ? m.expiration_date : null,
  };
}

/** The model list is public, so it works before a key is connected (apiKey may be null). */
export async function listModels(accountId: string, apiKey: string | null, refresh = false): Promise<ModelInfo[]> {
  const hit = cache.__orsModels;
  if (!refresh && hit && Date.now() - hit.at < TTL_MS) return hit.data;
  const body = await orJson<{ data: Raw[] }>(apiKey, "/models", {}, { accountId, kind: "meta" });
  const data = body.data.map(normalizeModel);
  cache.__orsModels = { at: Date.now(), data };
  return data;
}

export async function getModel(accountId: string, apiKey: string | null, id: string): Promise<ModelInfo | null> {
  const models = await listModels(accountId, apiKey);
  return models.find((m) => m.id === id) ?? null;
}

export async function listProviders(accountId: string, apiKey: string | null): Promise<ProviderInfo[]> {
  const hit = cache.__orsProviders;
  if (hit && Date.now() - hit.at < TTL_MS * 12) return hit.data;
  const body = await orJson<{ data: Raw[] }>(apiKey, "/providers", {}, { accountId, kind: "meta" });
  const data = body.data
    .map((p) => ({
      name: String(p.name),
      slug: String(p.slug),
      headquarters: typeof p.headquarters === "string" ? p.headquarters : null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  cache.__orsProviders = { at: Date.now(), data };
  return data;
}

/** Per-provider endpoints for one model: price, limits, uptime and live latency/throughput. */
export async function listEndpoints(accountId: string, apiKey: string | null, modelId: string): Promise<EndpointInfo[]> {
  // Model ids are `author/slug[:variant]`; each segment is encoded but the slash is structural.
  const path = modelId.split("/").map(encodeURIComponent).join("/");
  const body = await orJson<{ data: { endpoints?: Raw[] } }>(
    apiKey,
    `/models/${path}/endpoints`,
    {},
    { accountId, kind: "meta" },
  );
  return (body.data.endpoints ?? []).map((e) => {
    const pricing = (e.pricing ?? {}) as Raw;
    const latency = e.latency_last_30m as Raw | null;
    const throughput = e.throughput_last_30m as Raw | null;
    return {
      providerName: String(e.provider_name ?? ""),
      tag: String(e.tag ?? ""),
      contextLength: typeof e.context_length === "number" ? e.context_length : null,
      maxCompletionTokens: typeof e.max_completion_tokens === "number" ? e.max_completion_tokens : null,
      quantization: typeof e.quantization === "string" ? e.quantization : null,
      pricing: { prompt: price(pricing.prompt) ?? 0, completion: price(pricing.completion) ?? 0 },
      supportedParameters: strings(e.supported_parameters),
      uptime30m: typeof e.uptime_last_30m === "number" ? e.uptime_last_30m : null,
      latencyP50Ms: typeof latency?.p50 === "number" ? latency.p50 : null,
      throughputP50: typeof throughput?.p50 === "number" ? throughput.p50 : null,
      status: typeof e.status === "number" ? e.status : null,
    };
  });
}
