import { describe, expect, it } from "vitest";
import { emptyFilters, filterModels, matches } from "@/lib/shared/model-filter";
import { estimateCost, type ModelInfo } from "@/lib/shared/models";

function model(over: Partial<ModelInfo> & { id: string }): ModelInfo {
  return {
    name: over.id,
    author: over.id.split("/")[0],
    description: "",
    created: 0,
    contextLength: 128_000,
    maxCompletionTokens: 4096,
    inputModalities: ["text"],
    outputModalities: ["text"],
    tokenizer: null,
    moderated: false,
    pricing: { prompt: 1e-6, completion: 2e-6, image: null, request: null, cacheRead: null, cacheWrite: null, webSearch: null, internalReasoning: null },
    supportedParameters: [],
    reasoning: null,
    aliasOf: null,
    expiresAt: null,
    ...over,
  };
}

const cheap = model({ id: "a/cheap", created: 1, pricing: { ...model({ id: "x/x" }).pricing, prompt: 1e-7, completion: 2e-7 }, supportedParameters: ["tools"] });
const vision = model({ id: "b/vision", created: 3, inputModalities: ["text", "image"], supportedParameters: ["tools", "structured_outputs"], contextLength: 1_000_000 });
const free = model({ id: "c/free", created: 2, pricing: { ...model({ id: "x/x" }).pricing, prompt: 0, completion: 0 } });
const router = model({ id: "openrouter/auto", pricing: { ...model({ id: "x/x" }).pricing, prompt: -1, completion: -1 } });
const all = [cheap, vision, free, router];

describe("model filters", () => {
  it("matches every search term against id and name", () => {
    expect(matches(vision, { ...emptyFilters, query: "b vision" })).toBe(true);
    expect(matches(vision, { ...emptyFilters, query: "b cheap" })).toBe(false);
  });

  it("requires all selected modalities and parameters", () => {
    const f = { ...emptyFilters, inputModalities: ["image"], params: ["tools", "structured_outputs"] };
    expect(filterModels(all, f).map((m) => m.id)).toEqual(["b/vision"]);
  });

  it("applies price ceilings in dollars per million tokens", () => {
    const ids = filterModels(all, { ...emptyFilters, maxPromptPrice: 0.5 }).map((m) => m.id);
    expect(ids).toContain("a/cheap");
    expect(ids).toContain("c/free");
    expect(ids).not.toContain("b/vision");
  });

  it("never lets a variable-priced router through a price ceiling", () => {
    expect(matches(router, { ...emptyFilters, maxPromptPrice: 100 })).toBe(false);
    expect(matches(router, emptyFilters)).toBe(true);
  });

  it("filters by context, free-only and author", () => {
    expect(filterModels(all, { ...emptyFilters, minContext: 200_000 }).map((m) => m.id)).toEqual(["b/vision"]);
    expect(filterModels(all, { ...emptyFilters, freeOnly: true }).map((m) => m.id)).toEqual(["c/free"]);
    expect(filterModels(all, { ...emptyFilters, author: "a" }).map((m) => m.id)).toEqual(["a/cheap"]);
  });

  it("sorts", () => {
    expect(filterModels([cheap, vision, free], { ...emptyFilters, sort: "newest" }).map((m) => m.id)).toEqual(["b/vision", "c/free", "a/cheap"]);
    expect(filterModels([cheap, vision, free], { ...emptyFilters, sort: "price-asc" }).map((m) => m.id)).toEqual(["c/free", "a/cheap", "b/vision"]);
  });

  it("estimates cost from list prices", () => {
    expect(estimateCost(cheap, 1_000_000, 500_000)).toBeCloseTo(0.1 + 0.1, 10);
  });
});
