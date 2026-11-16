import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { ApiError } from "@/lib/server/api";
import { collectChat, openChat } from "@/lib/server/chat-stream";
import { orJson, UpstreamError } from "@/lib/server/openrouter";
import { saveSettings } from "@/lib/server/settings";
import { chatRequestSchema, type ChatStreamEvent } from "@/lib/shared/chat";
import { defaultSettings } from "@/lib/shared/settings";
import { data, MockOpenRouter } from "./helpers/mock-openrouter";

const mock = new MockOpenRouter();
const meta = { accountId: "acct_test", kind: "chat" as const };
// A tiny Retry-After keeps the retry tests fast while still exercising the header path.
const soon = { "retry-after": "0.01" };

beforeAll(async () => {
  process.env.OPENROUTER_BASE_URL = await mock.start();
});
afterAll(() => mock.stop());
beforeEach(() => {
  mock.reset();
  getDb().delete(schema.requestLogs).run();
});

const lastLog = () => getDb().select().from(schema.requestLogs).orderBy(desc(schema.requestLogs.ts)).all()[0];
const req = (over: Record<string, unknown> = {}) =>
  chatRequestSchema.parse({ model: "test/model", messages: [{ role: "user", content: "hi" }], ...over });

async function drain(gen: AsyncGenerator<ChatStreamEvent>) {
  const events: ChatStreamEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

describe("upstream retries", () => {
  it("retries a 429 and then succeeds, sending auth and attribution headers", async () => {
    mock.on("/key", { status: 429, json: { error: { code: 429, message: "slow down" } }, headers: soon }, { status: 200, json: { data: { label: "k" } } });
    const out = await orJson<{ data: { label: string } }>("sk-test", "/key", {}, { ...meta, kind: "meta" });
    expect(out.data.label).toBe("k");
    expect(mock.calls("/key")).toHaveLength(2);
    expect(mock.calls("/key")[0].headers.authorization).toBe("Bearer sk-test");
    expect(mock.calls("/key")[0].headers["x-openrouter-title"]).toBe("OpenRouter Studio");
    expect(lastLog()).toMatchObject({ ok: true, status: 200, retries: 1, endpoint: "/key" });
  });

  it("retries 5xx up to the limit, then surfaces the upstream error", async () => {
    mock.on("/key", { status: 503, json: { error: { code: 503, message: "no providers" } }, headers: soon });
    const err = (await orJson("sk-test", "/key", {}, meta).catch((e) => e)) as UpstreamError;
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err.status).toBe(503);
    expect(err.message).toBe("no providers");
    expect(mock.calls("/key")).toHaveLength(4); // 1 try + 3 retries
    expect(lastLog()).toMatchObject({ ok: false, status: 503, retries: 3, error: "no providers" });
  });

  it("does not retry client errors", async () => {
    mock.on("/key", { status: 400, json: { error: { code: 400, message: "bad request" } } });
    await expect(orJson("sk-test", "/key", {}, meta)).rejects.toMatchObject({ status: 400, message: "bad request" });
    expect(mock.calls("/key")).toHaveLength(1);
  });

  it("never passes an upstream 401 through as our own 401", async () => {
    mock.on("/key", { status: 401, json: { error: { code: 401, message: "No auth credentials found" } } });
    const err = (await orJson("sk-bad", "/key", {}, meta).catch((e) => e)) as UpstreamError;
    expect(err.status).toBe(502);
    expect(err.message).toContain("rejected the API key");
  });

  it("retries when the connection itself fails", async () => {
    let n = 0;
    mock.on("/key", () => (n++ === 0 ? { status: 502, json: { error: { message: "bad gateway" } }, headers: soon } : { status: 200, json: { data: {} } }));
    await orJson("sk-test", "/key", {}, meta);
    expect(n).toBe(2);
  });
});

describe("chat stream normalization", () => {
  it("normalizes a Chat Completions stream, skipping keep-alive comments", async () => {
    const chunk = (delta: object, extra: object = {}) => ({ id: "gen-1", model: "test/model-v2", provider: "Acme", choices: [{ index: 0, delta, finish_reason: null }], ...extra });
    mock.on("/chat/completions", {
      sse: [
        ": OPENROUTER PROCESSING\n\n",
        data(chunk({ reasoning: "thinking…" })),
        data(chunk({ content: "Hel" })),
        data(chunk({ content: "lo" })),
        data({ ...chunk({ content: "" }), choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 7, cost: 0.00042, completion_tokens_details: { reasoning_tokens: 3 }, prompt_tokens_details: { cached_tokens: 2 } } }),
        data("[DONE]"),
      ],
    });
    const events = await drain(await openChat(req(), { apiKey: "sk-test", meta }));
    expect(events.map((e) => e.type)).toEqual(["reasoning", "delta", "delta", "usage", "done"]);
    const usage = events.find((e) => e.type === "usage")!;
    expect(usage.type === "usage" && usage.usage).toMatchObject({
      promptTokens: 5, completionTokens: 7, reasoningTokens: 3, cachedTokens: 2, cost: 0.00042,
      model: "test/model-v2", provider: "Acme", generationId: "gen-1", finishReason: "stop", retries: 0,
    });
    expect(lastLog()).toMatchObject({ ok: true, streamed: true, model: "test/model", modelUsed: "test/model-v2", cost: 0.00042, promptTokens: 5, finishReason: "stop" });
    expect(lastLog().ttftMs).not.toBeNull();
  });

  it("normalizes a Responses API stream", async () => {
    mock.on("/responses", {
      sse: [
        data({ type: "response.created", response: { id: "gen-2", model: "test/model" } }),
        data({ type: "response.reasoning_summary_text.delta", delta: "hmm" }),
        data({ type: "response.output_text.delta", delta: "42" }),
        data({ type: "response.completed", response: { id: "gen-2", model: "test/model", usage: { input_tokens: 9, output_tokens: 4, cost: 0.001, output_tokens_details: { reasoning_tokens: 1 } } } }),
      ],
    });
    const result = await collectChat(req({ api: "responses" }), { apiKey: "sk-test", meta });
    expect(result).toMatchObject({ text: "42", reasoning: "hmm", error: null });
    expect(result.usage).toMatchObject({ promptTokens: 9, completionTokens: 4, reasoningTokens: 1, cost: 0.001, generationId: "gen-2", finishReason: "stop" });
    expect(mock.calls("/responses")[0].body).toMatchObject({ stream: true, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }] });
  });

  it("reports a mid-stream provider error as an event and logs the failure", async () => {
    mock.on("/chat/completions", {
      sse: [
        data({ id: "gen-3", choices: [{ delta: { content: "partial" } }] }),
        data({ id: "gen-3", error: { code: 502, message: "provider disconnected" }, choices: [{ delta: { content: "" }, finish_reason: "error" }] }),
        data("[DONE]"),
      ],
    });
    const result = await collectChat(req(), { apiKey: "sk-test", meta });
    expect(result.text).toBe("partial");
    expect(result.error).toBe("provider disconnected");
    expect(lastLog()).toMatchObject({ ok: false, error: "provider disconnected", finishReason: "error" });
  });

  it("throws (rather than streaming) when the request is rejected up front", async () => {
    mock.on("/chat/completions", { status: 402, json: { error: { code: 402, message: "Insufficient credits" } } });
    await expect(openChat(req(), { apiKey: "sk-test", meta })).rejects.toMatchObject({ status: 402, message: "Insufficient credits" });
    expect(lastLog()).toMatchObject({ ok: false, status: 402 });
  });

  it("stops reading and logs an abort when the caller cancels", async () => {
    mock.on("/chat/completions", { sse: Array.from({ length: 200 }, (_, i) => data({ id: "gen-4", choices: [{ delta: { content: `t${i} ` } }] })) });
    const abort = new AbortController();
    const gen = await openChat(req(), { apiKey: "sk-test", meta, signal: abort.signal });
    await gen.next();
    abort.abort();
    await gen.return(undefined);
    expect(lastLog()).toMatchObject({ ok: false, error: "aborted" });
  });
});

describe("budget hard stop", () => {
  it("blocks billable calls once the cap is spent, but not metadata calls", async () => {
    const accountId = "acct_budget";
    const db = getDb();
    db.insert(schema.accounts).values({ id: accountId, keyHash: "h-budget", keyEnc: "x", keyHint: "x", source: "paste" }).onConflictDoNothing().run();
    saveSettings(accountId, { ...defaultSettings, budgets: { ...defaultSettings.budgets, dailyUsd: 0.01, hardStop: true } });
    db.insert(schema.requestLogs).values({ id: "req_spent", accountId, ts: Date.now(), kind: "chat", endpoint: "/chat/completions", method: "POST", ok: true, cost: 0.02 }).run();

    mock.on("/chat/completions", { sse: [data("[DONE]")] }).on("/key", { status: 200, json: { data: {} } });
    const err = await openChat(req(), { apiKey: "sk-test", meta: { accountId, kind: "chat" } }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 402, code: "budget_exceeded" });
    expect(mock.calls("/chat/completions")).toHaveLength(0);
    await expect(orJson("sk-test", "/key", {}, { accountId, kind: "meta" })).resolves.toBeDefined();

    db.delete(schema.requestLogs).where(eq(schema.requestLogs.id, "req_spent")).run();
  });
});
