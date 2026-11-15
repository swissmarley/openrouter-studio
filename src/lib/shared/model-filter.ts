import { isFree, type ModelInfo } from "./models";

export type SortKey = "newest" | "price-asc" | "price-desc" | "context" | "name";

export interface ModelFilters {
  query: string;
  inputModalities: string[];
  outputModalities: string[];
  /** `supported_parameters` entries that must all be present. */
  params: string[];
  /** USD per million tokens; null = no limit. */
  maxPromptPrice: number | null;
  maxCompletionPrice: number | null;
  minContext: number;
  freeOnly: boolean;
  author: string;
  sort: SortKey;
}

export const emptyFilters: ModelFilters = {
  query: "",
  inputModalities: [],
  outputModalities: [],
  params: [],
  maxPromptPrice: null,
  maxCompletionPrice: null,
  minContext: 0,
  freeOnly: false,
  author: "",
  sort: "newest",
};

export function countActive(f: ModelFilters): number {
  return (
    (f.query.trim() ? 1 : 0) +
    f.inputModalities.length +
    f.outputModalities.length +
    f.params.length +
    (f.maxPromptPrice !== null ? 1 : 0) +
    (f.maxCompletionPrice !== null ? 1 : 0) +
    (f.minContext > 0 ? 1 : 0) +
    (f.freeOnly ? 1 : 0) +
    (f.author ? 1 : 0)
  );
}

const PER_M = 1_000_000;

export function matches(model: ModelInfo, f: ModelFilters): boolean {
  if (f.query.trim()) {
    const haystack = `${model.id} ${model.name}`.toLowerCase();
    // Every whitespace-separated term must appear, so "claude haiku" narrows rather than widens.
    if (!f.query.toLowerCase().split(/\s+/).filter(Boolean).every((term) => haystack.includes(term))) return false;
  }
  if (f.author && model.author !== f.author) return false;
  if (f.freeOnly && !isFree(model)) return false;
  if (model.contextLength < f.minContext) return false;
  if (!f.inputModalities.every((m) => model.inputModalities.includes(m))) return false;
  if (!f.outputModalities.every((m) => model.outputModalities.includes(m))) return false;
  if (!f.params.every((p) => model.supportedParameters.includes(p))) return false;
  // Router models report a negative ("varies") price; a price ceiling cannot vouch for them.
  if (f.maxPromptPrice !== null && (model.pricing.prompt < 0 || model.pricing.prompt * PER_M > f.maxPromptPrice)) return false;
  if (f.maxCompletionPrice !== null && (model.pricing.completion < 0 || model.pricing.completion * PER_M > f.maxCompletionPrice)) {
    return false;
  }
  return true;
}

const blended = (m: ModelInfo) => m.pricing.prompt + m.pricing.completion;

export function filterModels(models: ModelInfo[], f: ModelFilters): ModelInfo[] {
  const out = models.filter((m) => matches(m, f));
  switch (f.sort) {
    case "newest":
      return out.sort((a, b) => b.created - a.created);
    case "price-asc":
      return out.sort((a, b) => blended(a) - blended(b));
    case "price-desc":
      return out.sort((a, b) => blended(b) - blended(a));
    case "context":
      return out.sort((a, b) => b.contextLength - a.contextLength);
    case "name":
      return out.sort((a, b) => a.name.localeCompare(b.name));
  }
}
