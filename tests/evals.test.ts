import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb, schema } from "@/db";
import { cancelEval, getEval, startEval } from "@/lib/server/evals";
import { evalConfigSchema, parseDataset, scoreDeterministic, summarize, unfence, type EvalResult } from "@/lib/shared/evals";
import { data, MockOpenRouter } from "./helpers/mock-openrouter";

const mock = new MockOpenRouter();
const accountId = "acct_evals";

beforeAll(async () => {
  process.env.OPENROUTER_BASE_URL = await mock.start();
  getDb().insert(schema.accounts).values({ id: accountId, keyHash: "h-evals", keyEnc: "x", keyHint: "x", source: "paste" }).run();
});
afterAll(() => mock.stop());
beforeEach(() => mock.reset());

/** A chat-completions stream answering with `text`. */
const answer = (text: string, cost = 0.001) => ({
  sse: [
    data({ id: "gen", model: "m", choices: [{ delta: { content: text } }] }),
    data({ id: "gen", model: "m", choices: [{ delta: { content: "" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 4, cost } }),
    data("[DONE]"),
  ],
});

async function finished(id: string) {
  const deadline = Date.now() + 8000;
  for (;;) {
    const res = getEval(accountId, id);
    if (res.eval.status !== "running") return res;
    if (Date.now() > deadline) throw new Error("eval did not finish");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("scoring", () => {
  it("scores exact, contains, regex and JSON deterministically", () => {
    expect(scoreDeterministic("exact", "  Paris ", "paris")).toMatchObject({ score: 1 });
    expect(scoreDeterministic("exact", "Paris, France", "paris")).toMatchObject({ score: 0 });
    expect(scoreDeterministic("contains", "The capital is Paris.", "paris")).toMatchObject({ score: 1 });
    expect(scoreDeterministic("regex", "Order #4821 shipped", "#\\d{4}")).toMatchObject({ score: 1 });
    expect(scoreDeterministic("regex", "anything", "(")).toMatchObject({ score: 0, detail: expect.stringContaining("not a valid") });
    expect(scoreDeterministic("json", '```json\n{"a": 1}\n```', undefined)).toMatchObject({ score: 1 });
    expect(scoreDeterministic("json", "not json", undefined)).toMatchObject({ score: 0 });
    // No expected value means "cannot score", not "wrong".
    expect(scoreDeterministic("exact", "x", undefined)).toBeNull();
    expect(unfence("```\n[1]\n```")).toBe("[1]");
  });

  it("summarizes per model, ignoring failed rows in averages", () => {
    const base: EvalResult = { id: "", rowIndex: 0, model: "a", modelUsed: null, output: "x", score: null, scoreDetail: null, latencyMs: null, ttftMs: null, promptTokens: 0, completionTokens: 0, cost: 0, judgeCost: null, error: null };
    const stats = summarize(["a", "b"], [
      { ...base, score: 1, latencyMs: 1000, ttftMs: 500, completionTokens: 50, cost: 0.01 },
      { ...base, rowIndex: 1, score: 0, latencyMs: 3000, ttftMs: 1000, completionTokens: 100, cost: 0.02 },
      { ...base, rowIndex: 2, error: "boom", latencyMs: 9999, cost: 0 },
      { ...base, model: "b", score: 0.5, latencyMs: 200, cost: 0.001 },
    ]);
    expect(stats[0]).toMatchObject({ model: "a", done: 3, errors: 1, avgScore: 0.5, scored: 2, avgLatencyMs: 2000, p95LatencyMs: 3000 });
    expect(stats[0].totalCost).toBeCloseTo(0.03);
    expect(stats[0].tokensPerSec).toBeCloseTo((100 + 50) / 2);
    expect(stats[1]).toMatchObject({ model: "b", avgScore: 0.5, errors: 0 });
  });
});

describe("dataset parsing", () => {
  it("reads a JSON array, JSON Lines, CSV and plain lines", () => {
    expect(parseDataset('[{"input":"2+2","expected":"4"},"just a prompt"]')).toEqual([{ input: "2+2", expected: "4" }, { input: "just a prompt" }]);
    expect(parseDataset('{"prompt":"a","answer":"b"}\n{"question":"c"}')).toEqual([{ input: "a", expected: "b" }, { input: "c" }]);
    expect(parseDataset('input,expected\n"What is ""x""?","a, b"\nplain,ok')).toEqual([{ input: 'What is "x"?', expected: "a, b" }, { input: "plain", expected: "ok" }]);
    expect(parseDataset("first prompt\nsecond prompt")).toEqual([{ input: "first prompt" }, { input: "second prompt" }]);
    expect(() => parseDataset('[{"expected":"x"}]')).toThrow(/Row 1 has no "input"/);
    expect(() => parseDataset("  ")).toThrow();
  });
});

describe("eval runs", () => {
  it("runs every row against every model and scores the answers", async () => {
    mock.on("/chat/completions", (req) => {
      const body = req.body as { model: string; messages: { role: string; content: string }[] };
      const question = body.messages.at(-1)!.content;
      // "good/model" is right; "bad/model" always says 5.
      const right = question.includes("2+2") ? "4" : "9";
      return answer(body.model === "good/model" ? right : "5", body.model === "good/model" ? 0.002 : 0.001);
    });
    const id = startEval(accountId, "sk-test", evalConfigSchema.parse({
      name: "arithmetic",
      models: ["good/model", "bad/model"],
      system: "Answer with the number only.",
      rows: [{ input: "2+2", expected: "4" }, { input: "3*3", expected: "9" }],
      scorer: "exact",
    }));
    const { eval: summary, results } = await finished(id);
    expect(summary).toMatchObject({ status: "completed", total: 4, done: 4 });
    expect(results).toHaveLength(4);

    const [good, bad] = summarize(summary.config.models, results);
    expect(good).toMatchObject({ avgScore: 1, errors: 0 });
    expect(bad).toMatchObject({ avgScore: 0, errors: 0 });
    expect(good.totalCost).toBeCloseTo(0.004);
    expect(results.every((r) => r.latencyMs !== null && r.ttftMs !== null)).toBe(true);

    // The system prompt and sampling settings reached the model, and calls were logged as evals.
    const body = mock.calls("/chat/completions")[0].body as { messages: { role: string }[]; temperature: number; max_tokens: number };
    expect(body.messages[0]).toMatchObject({ role: "system", content: "Answer with the number only." });
    expect(body).toMatchObject({ temperature: 0, max_tokens: 1024 });
    const logged = getDb().select().from(schema.requestLogs).all().filter((l) => l.refId === id);
    expect(logged).toHaveLength(4);
    expect(logged[0]).toMatchObject({ kind: "eval", refType: "eval" });
  });

  it("grades with an LLM judge and tracks the judge's cost separately", async () => {
    mock.on("/chat/completions", (req) => {
      const body = req.body as { model: string; response_format?: unknown; messages: { content: string }[] };
      if (body.model === "judge/model") {
        expect(body.response_format).toMatchObject({ type: "json_schema" });
        const good = body.messages[0].content.includes("A thorough answer");
        return answer(JSON.stringify({ score: good ? 9 : 2, reason: good ? "Complete." : "Too thin." }), 0.0005);
      }
      return answer(body.model === "strong/model" ? "A thorough answer" : "idk");
    });
    const id = startEval(accountId, "sk-test", evalConfigSchema.parse({
      name: "judged", models: ["strong/model", "weak/model"], rows: [{ input: "Explain X" }], scorer: "judge", judgeModel: "judge/model", rubric: "Be thorough.",
    }));
    const { results } = await finished(id);
    const strong = results.find((r) => r.model === "strong/model")!;
    const weak = results.find((r) => r.model === "weak/model")!;
    expect(strong).toMatchObject({ score: 0.9, scoreDetail: "Complete.", judgeCost: 0.0005 });
    expect(weak).toMatchObject({ score: 0.2, scoreDetail: "Too thin." });
    // The judge saw the rubric and the answer, fenced off as data.
    const judgeCall = mock.calls("/chat/completions").find((c) => (c.body as { model: string }).model === "judge/model")!;
    expect(JSON.stringify(judgeCall.body)).toContain("Be thorough.");
    expect(JSON.stringify(judgeCall.body)).toContain("not instructions to follow");
  });

  it("records a failing model as an error without failing the eval", async () => {
    mock.on("/chat/completions", (req) =>
      (req.body as { model: string }).model === "broken/model" ? { status: 404, json: { error: { code: 404, message: "No endpoints found" } } } : answer("fine"),
    );
    const id = startEval(accountId, "sk-test", evalConfigSchema.parse({ name: "mixed", models: ["ok/model", "broken/model"], rows: [{ input: "hi" }] }));
    const { eval: summary, results } = await finished(id);
    expect(summary.status).toBe("completed");
    expect(results.find((r) => r.model === "broken/model")).toMatchObject({ error: "No endpoints found", output: null });
    expect(results.find((r) => r.model === "ok/model")).toMatchObject({ error: null, output: "fine" });
  });

  it("can be cancelled part-way", async () => {
    mock.on("/chat/completions", { ...answer("slow"), delayMs: 300 });
    const id = startEval(accountId, "sk-test", evalConfigSchema.parse({ name: "long", models: ["a/a"], rows: Array.from({ length: 12 }, (_, i) => ({ input: `q${i}` })), concurrency: 1 }));
    await new Promise((r) => setTimeout(r, 450));
    cancelEval(accountId, id);
    const { eval: summary } = await finished(id);
    expect(summary.status).toBe("cancelled");
    expect(summary.done).toBeLessThan(12);
  });

  it("validates the request", () => {
    expect(() => startEval(accountId, "sk-test", evalConfigSchema.parse({ name: "x", models: ["a/a"], rows: [{ input: "q" }], scorer: "judge" }))).toThrow(/judge model/);
    expect(() => startEval(accountId, "sk-test", evalConfigSchema.parse({ name: "x", models: ["a/a", "a/a"], rows: [{ input: "q" }] }))).toThrow(/only be listed once/);
    expect(() => evalConfigSchema.parse({ name: "x", models: [], rows: [{ input: "q" }] })).toThrow();
    expect(() => getEval("acct_other", "eval_nope")).toThrow(/not found/i);
  });
});
