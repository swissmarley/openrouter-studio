import { z } from "zod";

/**
 * Routing controls, shared by the chat playground, agents and evals. This mirrors
 * OpenRouter's `provider` request object plus the `models` fallback list.
 */

const slug = z.string().trim().min(1).max(120).regex(/^[\w./:-]+$/, "Provider slugs use letters, digits, '.', '/', ':' and '-'.");
const modelId = z.string().trim().min(1).max(200);

export const QUANTIZATIONS = ["int4", "int8", "fp4", "fp6", "fp8", "fp16", "bf16", "fp32", "unknown"] as const;

export const routingSchema = z.object({
  /** Tried in order if the primary model errors, is rate limited or refuses. */
  fallbackModels: z.array(modelId).max(8).default([]),
  /** `:nitro` sorts by throughput, `:floor` by price. Appended to every model id sent. */
  variant: z.enum(["none", "nitro", "floor"]).default("none"),
  /** For openrouter/auto only: glob patterns the router may choose from. */
  autoAllowedModels: z.array(z.string().trim().min(1).max(200)).max(30).default([]),
  provider: z
    .object({
      order: z.array(slug).max(20).default([]),
      only: z.array(slug).max(40).default([]),
      ignore: z.array(slug).max(40).default([]),
      allowFallbacks: z.boolean().default(true),
      requireParameters: z.boolean().default(false),
      sort: z.enum(["default", "price", "throughput", "latency"]).default("default"),
      /** "deny" skips providers that may store or train on your data. */
      dataCollection: z.enum(["allow", "deny"]).default("allow"),
      /** Only route to Zero Data Retention endpoints. */
      zdr: z.boolean().default(false),
      quantizations: z.array(z.enum(QUANTIZATIONS)).max(QUANTIZATIONS.length).default([]),
      /** Price ceilings in USD per million tokens. */
      maxPromptPrice: z.number().positive().max(100_000).nullable().default(null),
      maxCompletionPrice: z.number().positive().max(100_000).nullable().default(null),
    })
    .prefault({}),
});

export type Routing = z.infer<typeof routingSchema>;
export const defaultRouting: Routing = routingSchema.parse({});

const VARIANT_SUFFIX = /:(nitro|floor)$/;

/** Applies the :nitro / :floor shortcut, replacing one that is already on the id. */
export function withVariant(model: string, variant: Routing["variant"]): string {
  if (variant === "none") return model;
  return `${model.replace(VARIANT_SUFFIX, "")}:${variant}`;
}

/** The `provider` object to send upstream, or undefined when everything is at its default. */
export function toProviderPrefs(r: Routing): Record<string, unknown> | undefined {
  const p = r.provider;
  const out: Record<string, unknown> = {};
  if (p.order.length) out.order = p.order;
  if (p.only.length) out.only = p.only;
  if (p.ignore.length) out.ignore = p.ignore;
  if (!p.allowFallbacks) out.allow_fallbacks = false;
  if (p.requireParameters) out.require_parameters = true;
  if (p.sort !== "default") out.sort = p.sort;
  if (p.dataCollection === "deny") out.data_collection = "deny";
  if (p.zdr) out.zdr = true;
  if (p.quantizations.length) out.quantizations = p.quantizations;
  if (p.maxPromptPrice !== null || p.maxCompletionPrice !== null) {
    out.max_price = {
      ...(p.maxPromptPrice !== null ? { prompt: p.maxPromptPrice } : {}),
      ...(p.maxCompletionPrice !== null ? { completion: p.maxCompletionPrice } : {}),
    };
  }
  return Object.keys(out).length ? out : undefined;
}

/** `model` / `models` fields: a fallback list becomes `models`, with the primary first. */
export function toModelFields(model: string, r: Routing): { model: string } | { models: string[] } {
  const primary = withVariant(model, r.variant);
  const fallbacks = r.fallbackModels.map((m) => withVariant(m, r.variant)).filter((m) => m !== primary);
  return fallbacks.length ? { models: [primary, ...fallbacks] } : { model: primary };
}

export function isAutoRouter(model: string): boolean {
  return model.replace(VARIANT_SUFFIX, "").startsWith("openrouter/auto");
}

/** Number of non-default routing settings, for the "N active" badge. */
export function countRouting(r: Routing): number {
  const p = r.provider;
  return (
    (r.fallbackModels.length ? 1 : 0) +
    (r.variant !== "none" ? 1 : 0) +
    (r.autoAllowedModels.length ? 1 : 0) +
    (p.order.length ? 1 : 0) +
    (p.only.length ? 1 : 0) +
    (p.ignore.length ? 1 : 0) +
    (!p.allowFallbacks ? 1 : 0) +
    (p.requireParameters ? 1 : 0) +
    (p.sort !== "default" ? 1 : 0) +
    (p.dataCollection === "deny" ? 1 : 0) +
    (p.zdr ? 1 : 0) +
    (p.quantizations.length ? 1 : 0) +
    (p.maxPromptPrice !== null || p.maxCompletionPrice !== null ? 1 : 0)
  );
}
