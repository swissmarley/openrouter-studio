import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { buildSnapshot, cancelRun, decideApproval, dropLiveRun, getController, getRunRow, listEvents, startRun } from "@/lib/server/agents/runner";
import { createAgent, createCustomTool } from "@/lib/server/agents/store";
import { saveSettings } from "@/lib/server/settings";
import { workspaceDir } from "@/lib/server/tools/builtin";
import { resetRateLimits } from "@/lib/server/tools/guard";
import { agentConfigSchema } from "@/lib/shared/agents";
import type { RunEvent } from "@/lib/shared/runs";
import { defaultSettings } from "@/lib/shared/settings";
import { MockOpenRouter } from "./helpers/mock-openrouter";
import { textReply, toolReply } from "./helpers/responses";

const mock = new MockOpenRouter();
const accountId = "acct_runner";
const soon = { "retry-after": "0.01" };

beforeAll(async () => {
  process.env.OPENROUTER_BASE_URL = await mock.start();
  getDb().insert(schema.accounts).values({ id: accountId, keyHash: "h-runner", keyEnc: "x", keyHint: "x", source: "paste" }).run();
});
afterAll(() => mock.stop());
beforeEach(() => {
  mock.reset();
  resetRateLimits();
  saveSettings(accountId, defaultSettings);
  const db = getDb();
  db.delete(schema.requestLogs).run();
  db.delete(schema.toolCalls).run();
});

let seq = 0;
function agent(config: Record<string, unknown>, name = `agent-${++seq}`) {
  return createAgent(accountId, { name, description: "", config: agentConfigSchema.parse({ model: "test/model", ...config }) });
}

function start(agentId: string, input = "go") {
  return startRun({ accountId, apiKey: "sk-test", snapshot: buildSnapshot(accountId, agentId), input, agentId });
}

async function until(runId: string, done: (status: string) => boolean, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = getRunRow(accountId, runId);
    if (done(row.status)) return row;
    if (Date.now() > deadline) throw new Error(`run stuck in "${row.status}": ${JSON.stringify(listEvents(runId).map((e) => e.type))}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}
const finished = (runId: string) => until(runId, (s) => ["completed", "failed", "cancelled"].includes(s));
const types = (runId: string) => listEvents(runId).map((e) => e.type);
const eventsOf = <T extends RunEvent["type"]>(runId: string, type: T) => listEvents(runId).filter((e): e is Extract<RunEvent, { type: T }> => e.type === type);
const bodies = () => mock.calls("/responses").map((c) => c.body as Record<string, unknown>);

describe("agent loop", () => {
  it("runs tools through the SDK loop and records a complete trace", async () => {
    mock.on("/responses", toolReply([{ name: "run_javascript", args: { code: "6 * 7" } }], { input: 100, output: 20, cost: 0.002 }), textReply("The answer is 42.", { input: 150, output: 10, cost: 0.003 }));
    const a = agent({ tools: ["builtin:run_javascript"], instructions: "be exact" });
    const runId = start(a.id, "what is 6*7?");
    const row = await finished(runId);

    expect(row).toMatchObject({ status: "completed", output: "The answer is 42.", stopReason: "completed", steps: 2, promptTokens: 250, completionTokens: 30 });
    expect(row.cost).toBeCloseTo(0.005, 10);
    expect(types(runId)).toEqual(["run.started", "step.started", "tool.call", "step.finished", "tool.result", "step.started", "message", "step.finished", "run.finished"]);

    const [call] = eventsOf(runId, "tool.call");
    expect(call).toMatchObject({ name: "run_javascript", source: "builtin", args: { code: "6 * 7" }, requiresApproval: false, agent: a.name, depth: 0 });
    const [result] = eventsOf(runId, "tool.result");
    expect(result).toMatchObject({ status: "ok", callId: call.callId, result: { result: 42, logs: [] } });

    // The request carried our instructions, the tool's JSON Schema, and the key.
    const [first, second] = bodies();
    expect(first).toMatchObject({ model: "test/model", instructions: "be exact", stream: true });
    expect((first.tools as { name: string; parameters: { properties: object } }[])[0]).toMatchObject({ name: "run_javascript", parameters: { properties: { code: {} } } });
    expect(mock.calls("/responses")[0].headers.authorization).toBe("Bearer sk-test");
    // ...and the second turn sent the tool's output back to the model.
    expect(JSON.stringify(second.input)).toContain("function_call_output");

    // Every model call and every tool call is logged.
    const logs = getDb().select().from(schema.requestLogs).all();
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatchObject({ kind: "agent", ok: true, refType: "run", refId: runId });
    expect(getDb().select().from(schema.toolCalls).all()).toMatchObject([{ toolName: "run_javascript", status: "ok", approval: "auto", runId, source: "builtin" }]);
  });

  it("stops at maxSteps and asks for a closing answer without tools", async () => {
    // A model that would call tools forever.
    mock.on("/responses", (req) =>
      (req.body as { tool_choice?: unknown }).tool_choice === "none" ? textReply("Stopping here.") : toolReply([{ name: "run_javascript", args: { code: "1" } }]),
    );
    const runId = start(agent({ tools: ["builtin:run_javascript"], maxSteps: 3, budgetUsd: null }).id);
    const row = await finished(runId);
    expect(row).toMatchObject({ status: "completed", stopReason: "max_steps", output: "Stopping here." });
    // 3 tool-calling steps, then exactly one answer-only turn.
    expect(bodies()).toHaveLength(4);
    expect(bodies()[3].tool_choice).toBe("none");
    expect(eventsOf(runId, "tool.result")).toHaveLength(3);
  });

  it("stops when the budget cap is spent", async () => {
    mock.on("/responses", (req) =>
      (req.body as { tool_choice?: unknown }).tool_choice === "none" ? textReply("Out of budget.", { cost: 0.001 }) : toolReply([{ name: "run_javascript", args: { code: "1" } }], { cost: 0.03 }),
    );
    const runId = start(agent({ tools: ["builtin:run_javascript"], maxSteps: 20, budgetUsd: 0.05 }).id);
    const row = await finished(runId);
    expect(row).toMatchObject({ status: "completed", stopReason: "budget" });
    // 0.03 + 0.03 crosses the 0.05 cap: two paid steps, then the closing turn.
    expect(eventsOf(runId, "tool.result")).toHaveLength(2);
    expect(row.cost).toBeGreaterThanOrEqual(0.05);
    expect(row.cost).toBeLessThan(0.07);
  });

  it("retries a rate-limited model call and records the retry", async () => {
    mock.on("/responses", { status: 429, json: { error: { code: 429, message: "slow down" } }, headers: soon }, textReply("ok"));
    const runId = start(agent({}).id);
    expect(await finished(runId)).toMatchObject({ status: "completed", output: "ok" });
    expect(mock.calls("/responses")).toHaveLength(2);
    expect(getDb().select().from(schema.requestLogs).all()).toMatchObject([{ ok: true, retries: 1 }]);
  });

  it("fails the run with the upstream message when the model call is rejected", async () => {
    mock.on("/responses", { status: 402, json: { error: { code: 402, message: "Insufficient credits" } } });
    const runId = start(agent({}).id);
    const row = await finished(runId);
    expect(row.status).toBe("failed");
    expect(row.error).toContain("Insufficient credits");
    expect(eventsOf(runId, "run.finished")[0]).toMatchObject({ status: "failed", stopReason: "error" });
    expect(getDb().select().from(schema.requestLogs).all()).toMatchObject([{ ok: false, status: 402, kind: "agent" }]);
    expect(getController(runId)).toBeUndefined();
  });

  it("turns a failing tool into an error result the model can react to", async () => {
    mock.on("/responses", toolReply([{ name: "file_read", args: { path: "../../etc/passwd" } }]), textReply("I could not read that."));
    const runId = start(agent({ tools: ["builtin:file_read"] }).id);
    expect(await finished(runId)).toMatchObject({ status: "completed" });
    expect(eventsOf(runId, "tool.result")[0]).toMatchObject({ status: "error", result: { error: "That path is outside the workspace." } });
  });

  it("rate-limits tool calls per account", async () => {
    saveSettings(accountId, { ...defaultSettings, tools: { rateLimitPerMin: 1 } });
    mock.on("/responses", toolReply([{ name: "run_javascript", args: { code: "1" } }, { name: "run_javascript", args: { code: "2" } }]), textReply("done"));
    const runId = start(agent({ tools: ["builtin:run_javascript"] }).id);
    await finished(runId);
    const statuses = eventsOf(runId, "tool.result").map((e) => e.status).sort();
    expect(statuses).toEqual(["ok", "rate_limited"]);
    expect(getDb().select().from(schema.toolCalls).all().map((c) => c.status).sort()).toEqual(["ok", "rate_limited"]);
  });

  it("runs a custom Zod + JS tool in the sandbox, validating its arguments", async () => {
    const tool = createCustomTool(accountId, {
      name: "shout",
      description: "Uppercase a word",
      schemaSource: `z.object({ word: z.string().min(1) })`,
      code: `return { loud: input.word.toUpperCase() + "!" };`,
      requireApproval: false,
      allowNetwork: false,
      timeoutMs: 1000,
    });
    mock.on("/responses", toolReply([{ name: "shout", args: { word: "hi" } }]), textReply("HI!"));
    const runId = start(agent({ tools: [`custom:${tool.id}`] }).id);
    await finished(runId);
    expect(eventsOf(runId, "tool.call")[0]).toMatchObject({ source: "custom" });
    expect(eventsOf(runId, "tool.result")[0]).toMatchObject({ status: "ok", result: { loud: "HI!" } });
  });

  it("warns instead of failing when a referenced tool no longer exists", async () => {
    mock.on("/responses", textReply("fine"));
    const runId = start(agent({ tools: ["custom:tool_gone", "builtin:run_javascript"] }).id);
    expect(await finished(runId)).toMatchObject({ status: "completed" });
    expect(eventsOf(runId, "notice")[0].message).toMatch(/has been deleted/);
  });
});

describe("human approval", () => {
  const gated = () => agent({ tools: ["builtin:file_write"], requireApproval: ["builtin:file_write"] });
  const file = (name: string) => path.join(workspaceDir(accountId), name);

  it("does not run a gated tool until a human approves it", async () => {
    mock.on("/responses", toolReply([{ name: "file_write", args: { path: "ok.txt", content: "approved" }, id: "call_w1" }]), textReply("Saved."));
    const runId = start(gated().id);
    await until(runId, (s) => s === "awaiting_approval");

    expect(fs.existsSync(file("ok.txt"))).toBe(false);
    expect(eventsOf(runId, "tool.call")[0]).toMatchObject({ requiresApproval: true });
    expect(eventsOf(runId, "approval.requested")[0].calls).toEqual([{ id: "call_w1", name: "file_write", args: { path: "ok.txt", content: "approved" } }]);

    decideApproval(accountId, "sk-test", runId, { approve: ["call_w1"], reject: [] });
    expect(await finished(runId)).toMatchObject({ status: "completed", output: "Saved." });
    expect(fs.readFileSync(file("ok.txt"), "utf8")).toBe("approved");
    expect(getDb().select().from(schema.toolCalls).all()).toMatchObject([{ toolName: "file_write", status: "ok", approval: "approved" }]);
  });

  it("tells the model when a call is rejected, and never runs it", async () => {
    mock.on("/responses", toolReply([{ name: "file_write", args: { path: "no.txt", content: "x" }, id: "call_w2" }]), textReply("Understood, not saved."));
    const runId = start(gated().id);
    await until(runId, (s) => s === "awaiting_approval");
    decideApproval(accountId, "sk-test", runId, { approve: [], reject: ["call_w2"] });
    expect(await finished(runId)).toMatchObject({ status: "completed", output: "Understood, not saved." });

    expect(fs.existsSync(file("no.txt"))).toBe(false);
    expect(eventsOf(runId, "tool.result")[0]).toMatchObject({ status: "rejected", callId: "call_w2" });
    expect(getDb().select().from(schema.toolCalls).all()).toMatchObject([{ status: "rejected", approval: "rejected" }]);
    // The follow-up request tells the model the call was declined.
    expect(JSON.stringify(bodies()[1].input)).toMatch(/reject|denied|declin/i);
  });

  it("rejects decisions for calls that are not pending", async () => {
    mock.on("/responses", toolReply([{ name: "file_write", args: { path: "p.txt", content: "x" }, id: "call_w3" }]), textReply("ok"));
    const runId = start(gated().id);
    await until(runId, (s) => s === "awaiting_approval");
    expect(() => decideApproval(accountId, "sk-test", runId, { approve: ["call_other"], reject: [] })).toThrow(/not waiting for approval/);
    expect(() => decideApproval("acct_someone_else", "sk-test", runId, { approve: ["call_w3"], reject: [] })).toThrow(/not found/i);
    cancelRun(accountId, runId);
    expect(await finished(runId)).toMatchObject({ status: "cancelled" });
  });

  it("resumes a pending approval from stored state after a restart", async () => {
    mock.on("/responses", toolReply([{ name: "file_write", args: { path: "restart.txt", content: "survived" }, id: "call_w4" }]), textReply("Saved after restart."));
    const runId = start(gated().id);
    await until(runId, (s) => s === "awaiting_approval");

    dropLiveRun(runId); // the process "restarts": all in-memory run state is gone
    expect(getController(runId)).toBeUndefined();

    decideApproval(accountId, "sk-test", runId, { approve: ["call_w4"], reject: [] });
    expect(await finished(runId)).toMatchObject({ status: "completed", output: "Saved after restart." });
    expect(fs.readFileSync(file("restart.txt"), "utf8")).toBe("survived");
    // The trace continues where it left off, with no gap or reuse of sequence numbers.
    const seqs = listEvents(runId).map((e) => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
  });
});

describe("pause, resume and cancel", () => {
  it("holds tool execution while paused", async () => {
    mock.on("/responses", toolReply([{ name: "run_javascript", args: { code: "1" } }], {}, { delayMs: 120 }), textReply("done"));
    const runId = start(agent({ tools: ["builtin:run_javascript"] }).id);
    expect(getController(runId)!.pause()).toBe(true);
    await new Promise((r) => setTimeout(r, 400));

    // The model's reply arrived, but its tool call is held at the gate.
    expect(getRunRow(accountId, runId).status).toBe("paused");
    expect(types(runId)).toContain("tool.call");
    expect(types(runId)).not.toContain("tool.result");

    expect(getController(runId)!.resume()).toBe(true);
    expect(await finished(runId)).toMatchObject({ status: "completed", output: "done" });
    expect(types(runId)).toEqual(expect.arrayContaining(["run.paused", "run.resumed", "tool.result"]));
  });

  it("cancels an in-flight run", async () => {
    mock.on("/responses", textReply("too late", {}, { delayMs: 2000 }));
    const runId = start(agent({}).id);
    await new Promise((r) => setTimeout(r, 100));
    cancelRun(accountId, runId);
    const row = await finished(runId);
    expect(row).toMatchObject({ status: "cancelled", stopReason: "cancelled", output: null });
    expect(getController(runId)).toBeUndefined();
  });
});

describe("multi-agent", () => {
  it("lets an agent delegate to a sub-agent and use its answer", async () => {
    const helper = agent({ instructions: "helper" }, "Helper Bot");
    const lead = agent({ subAgents: [helper.id], instructions: "lead" }, "Lead");
    mock.on(
      "/responses",
      toolReply([{ name: "ask_helper_bot", args: { task: "What is the capital of France?" } }], { cost: 0.001 }),
      textReply("Paris", { cost: 0.002 }), // the sub-agent's answer
      textReply("The helper says Paris.", { cost: 0.001 }),
    );
    const runId = start(lead.id);
    const row = await finished(runId);
    expect(row).toMatchObject({ status: "completed", output: "The helper says Paris.", steps: 3 });
    expect(row.cost).toBeCloseTo(0.004, 10); // the sub-agent's spend counts toward the run

    expect(eventsOf(runId, "subagent.started")[0]).toMatchObject({ agent: "Helper Bot", depth: 1, task: "What is the capital of France?" });
    expect(eventsOf(runId, "subagent.finished")[0]).toMatchObject({ output: "Paris" });
    expect(eventsOf(runId, "tool.result")[0]).toMatchObject({ name: "ask_helper_bot", status: "ok", result: { answer: "Paris" } });
    // The sub-agent ran with its own instructions and only the task as input.
    expect(bodies()[1]).toMatchObject({ instructions: "helper" });
    expect(JSON.stringify(bodies()[1].input)).toContain("capital of France");
  });

  it("hands the task over to another agent without an extra turn", async () => {
    const specialist = agent({ instructions: "specialist" }, "Specialist");
    const front = agent({ handoffs: [specialist.id], instructions: "front" }, "Front Desk");
    mock.on("/responses", toolReply([{ name: "handoff_to_specialist", args: { reason: "needs an expert", context: "User wants X done." } }]), textReply("X is done."));
    const runId = start(front.id, "please do X");
    const row = await finished(runId);
    expect(row).toMatchObject({ status: "completed", output: "X is done." });
    expect(eventsOf(runId, "handoff")[0]).toMatchObject({ from: "Front Desk", to: "Specialist", reason: "needs an expert" });

    // Exactly two model calls: the front desk's handoff, then the specialist's answer.
    expect(bodies()).toHaveLength(2);
    expect(bodies()[1]).toMatchObject({ instructions: "specialist" });
    const briefing = JSON.stringify(bodies()[1].input);
    expect(briefing).toContain("please do X");
    expect(briefing).toContain("User wants X done.");
  });

  it("freezes agent definitions at launch so later edits do not change a run", async () => {
    const a = agent({ instructions: "v1" });
    const snapshot = buildSnapshot(accountId, a.id);
    getDb().update(schema.agents).set({ config: { ...a.config, instructions: "v2" } }).where(eq(schema.agents.id, a.id)).run();
    mock.on("/responses", textReply("ok"));
    const runId = startRun({ accountId, apiKey: "sk-test", snapshot, input: "go", agentId: a.id });
    await finished(runId);
    expect(bodies()[0]).toMatchObject({ instructions: "v1" });
  });
});
