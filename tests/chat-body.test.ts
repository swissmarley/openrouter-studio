import { describe, expect, it } from "vitest";
import { buildChatCompletionsBody, buildResponsesBody, chatRequestSchema } from "@/lib/shared/chat";
import { routingSchema, toModelFields, toProviderPrefs, withVariant } from "@/lib/shared/routing";

const base = { model: "a/b", messages: [{ role: "user", content: "hi" }] };

describe("request bodies", () => {
  it("sends only what was set", () => {
    const body = buildChatCompletionsBody(chatRequestSchema.parse(base));
    expect(body).toEqual({ model: "a/b", stream: true, messages: [{ role: "user", content: "hi" }] });
  });

  it("maps sampling, reasoning, system prompt and JSON schema for Chat Completions", () => {
    const body = buildChatCompletionsBody(
      chatRequestSchema.parse({
        ...base,
        system: "be brief",
        sampling: { temperature: 0, maxTokens: 50, seed: 7, stop: ["END"] },
        reasoning: { mode: "on", effort: "high", exclude: true },
        responseFormat: { type: "json_schema", name: "out", schema: { type: "object" } },
      }),
    );
    expect(body).toMatchObject({
      temperature: 0,
      max_tokens: 50,
      seed: 7,
      stop: ["END"],
      reasoning: { enabled: true, effort: "high", exclude: true },
      response_format: { type: "json_schema", json_schema: { name: "out", strict: true, schema: { type: "object" } } },
    });
    expect(body.messages).toEqual([{ role: "system", content: "be brief" }, { role: "user", content: "hi" }]);
  });

  it("maps the same request onto the Responses API", () => {
    const body = buildResponsesBody(
      chatRequestSchema.parse({
        ...base,
        api: "responses",
        system: "be brief",
        messages: [{ role: "user", content: "q" }, { role: "assistant", content: "a" }, { role: "user", content: "q2" }],
        sampling: { maxTokens: 50 },
        reasoning: { mode: "off", effort: "high" },
        responseFormat: { type: "json_schema", name: "out", schema: { type: "object" } },
      }),
    );
    expect(body).toMatchObject({
      instructions: "be brief",
      max_output_tokens: 50,
      reasoning: { enabled: false },
      text: { format: { type: "json_schema", name: "out", strict: true, schema: { type: "object" } } },
    });
    expect((body.input as { role: string; content: { type: string }[] }[]).map((m) => [m.role, m.content[0].type])).toEqual([
      ["user", "input_text"],
      ["assistant", "output_text"],
      ["user", "input_text"],
    ]);
  });

  it("encodes image, PDF and audio parts for each API", () => {
    const parts = [
      { type: "text", text: "look" },
      { type: "image", url: "data:image/png;base64,AAAA" },
      { type: "file", filename: "a.pdf", data: "data:application/pdf;base64,BBBB" },
      { type: "audio", data: "CCCC", format: "wav" },
    ];
    const request = chatRequestSchema.parse({ model: "a/b", messages: [{ role: "user", content: parts }], pdfEngine: "mistral-ocr" });
    const chat = buildChatCompletionsBody(request) as { messages: { content: unknown[] }[]; plugins: unknown };
    expect(chat.messages[0].content).toEqual([
      { type: "text", text: "look" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      { type: "file", file: { filename: "a.pdf", file_data: "data:application/pdf;base64,BBBB" } },
      { type: "input_audio", input_audio: { data: "CCCC", format: "wav" } },
    ]);
    expect(chat.plugins).toEqual([{ id: "file-parser", pdf: { engine: "mistral-ocr" } }]);
    const responses = buildResponsesBody({ ...request, api: "responses" }) as { input: { content: unknown[] }[] };
    expect(responses.input[0].content).toEqual([
      { type: "input_text", text: "look" },
      { type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "auto" },
      { type: "input_file", filename: "a.pdf", file_data: "data:application/pdf;base64,BBBB" },
      { type: "input_audio", input_audio: { data: "CCCC", format: "wav" } },
    ]);
  });

  it("rejects malformed attachments and oversized inputs", () => {
    expect(() => chatRequestSchema.parse({ model: "a/b", messages: [{ role: "user", content: [{ type: "image", url: "javascript:alert(1)" }] }] })).toThrow();
    expect(() => chatRequestSchema.parse({ model: "a/b", messages: [{ role: "user", content: [{ type: "audio", data: "not base64!", format: "wav" }] }] })).toThrow();
    expect(() => chatRequestSchema.parse({ model: "a/b", messages: [{ role: "tool", content: "x" }] })).toThrow();
    expect(() => chatRequestSchema.parse({ ...base, sampling: { temperature: 9 } })).toThrow();
  });
});

describe("routing", () => {
  it("is absent from the body when left at defaults", () => {
    expect(toProviderPrefs(routingSchema.parse({}))).toBeUndefined();
    expect(toModelFields("a/b", routingSchema.parse({}))).toEqual({ model: "a/b" });
  });

  it("turns fallbacks into an ordered `models` list and applies the variant to each", () => {
    const r = routingSchema.parse({ fallbackModels: ["c/d", "a/b", "e/f"], variant: "nitro" });
    expect(toModelFields("a/b", r)).toEqual({ models: ["a/b:nitro", "c/d:nitro", "e/f:nitro"] });
    expect(withVariant("a/b:floor", "nitro")).toBe("a/b:nitro");
    expect(withVariant("a/b:free", "floor")).toBe("a/b:free:floor");
  });

  it("maps provider preferences and data policy to OpenRouter's field names", () => {
    const r = routingSchema.parse({
      provider: { order: ["anthropic"], only: ["anthropic", "google-vertex"], ignore: ["deepinfra"], allowFallbacks: false, requireParameters: true, sort: "throughput", dataCollection: "deny", zdr: true, quantizations: ["fp8"], maxPromptPrice: 1, maxCompletionPrice: 2 },
    });
    expect(toProviderPrefs(r)).toEqual({
      order: ["anthropic"], only: ["anthropic", "google-vertex"], ignore: ["deepinfra"], allow_fallbacks: false, require_parameters: true,
      sort: "throughput", data_collection: "deny", zdr: true, quantizations: ["fp8"], max_price: { prompt: 1, completion: 2 },
    });
  });

  it("adds auto-router allowed models only for openrouter/auto", () => {
    const routing = { autoAllowedModels: ["anthropic/*"] };
    expect(buildChatCompletionsBody(chatRequestSchema.parse({ ...base, model: "openrouter/auto", routing })).plugins).toEqual([{ id: "auto-router", allowed_models: ["anthropic/*"] }]);
    expect(buildChatCompletionsBody(chatRequestSchema.parse({ ...base, routing })).plugins).toBeUndefined();
  });
});
