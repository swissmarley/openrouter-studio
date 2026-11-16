/** The slimmed-down model shape the browser works with. Prices are USD per token. */
export interface ModelInfo {
  id: string;
  name: string;
  author: string;
  description: string;
  created: number;
  contextLength: number;
  maxCompletionTokens: number | null;
  inputModalities: string[];
  outputModalities: string[];
  tokenizer: string | null;
  moderated: boolean;
  pricing: {
    prompt: number;
    completion: number;
    image: number | null;
    request: number | null;
    cacheRead: number | null;
    cacheWrite: number | null;
    webSearch: number | null;
    internalReasoning: number | null;
  };
  supportedParameters: string[];
  reasoning: {
    mandatory: boolean;
    defaultEnabled: boolean;
    supportedEfforts: string[] | null;
    defaultEffort: string | null;
    supportsMaxTokens: boolean;
  } | null;
  /** Set on `~vendor/family-latest` aliases. */
  aliasOf: string | null;
  expiresAt: string | null;
}

export interface EndpointInfo {
  providerName: string;
  tag: string;
  contextLength: number | null;
  maxCompletionTokens: number | null;
  quantization: string | null;
  pricing: { prompt: number; completion: number };
  supportedParameters: string[];
  uptime30m: number | null;
  latencyP50Ms: number | null;
  throughputP50: number | null;
  status: number | null;
}

export interface ProviderInfo {
  name: string;
  slug: string;
  headquarters: string | null;
}

/** Capabilities the explorer can filter on, mapped to `supported_parameters` entries. */
export const CAPABILITIES = [
  { key: "tools", label: "Tools", param: "tools" },
  { key: "structured", label: "Structured output", param: "structured_outputs" },
  { key: "reasoning", label: "Reasoning", param: "reasoning" },
  { key: "json", label: "JSON mode", param: "response_format" },
  { key: "seed", label: "Seed", param: "seed" },
  { key: "logprobs", label: "Logprobs", param: "logprobs" },
] as const;

export function supports(model: Pick<ModelInfo, "supportedParameters">, param: string): boolean {
  return model.supportedParameters.includes(param);
}

export function isFree(model: Pick<ModelInfo, "pricing">): boolean {
  return model.pricing.prompt === 0 && model.pricing.completion === 0;
}

/** Cost in USD for a call, from list prices. Real billed cost comes from the API's usage block. */
export function estimateCost(model: Pick<ModelInfo, "pricing">, promptTokens: number, completionTokens: number): number {
  return promptTokens * model.pricing.prompt + completionTokens * model.pricing.completion + (model.pricing.request ?? 0);
}
