import "server-only";
import {
  deserializeConversationState,
  maxCost,
  OpenRouter,
  serializeConversationState,
  stepCountIs,
  type ConversationState,
  type StateAccessor,
  type StopCondition,
  type Tool,
} from "@openrouter/agent";
import { HTTPClient } from "@openrouter/sdk/lib/http.js";
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { agentConfigSchema, slugify, type AgentConfig } from "@/lib/shared/agents";
import { toModelFields, type Routing } from "@/lib/shared/routing";
import { isTerminal, type RunEvent, type RunEventData, type RunStatus, type RunTotals, type ToolSource } from "@/lib/shared/runs";
import { ApiError } from "../api";
import { newId } from "../crypto";
import { env } from "../env";
import { retrying, writeRequestLog } from "../openrouter";
import { assertWithinBudget } from "../settings";
import { logToolCall, toSdkTool } from "../tools/guard";
import { resolveTools } from "../tools/registry";
import type { ToolHost } from "../tools/types";

/**
 * The agent harness. A run executes detached from any HTTP request, so the browser can
 * disconnect and reconnect; everything that happens is appended to an event log
 * (persisted, and pushed to live subscribers) that doubles as the trace and the replay.
 *
 * The loop itself is the Agent SDK's `callModel`: tools are `tool()` definitions with Zod
 * schemas, bounds are stop conditions (`stepCountIs`, `maxCost`), and human approval uses
 * the SDK's `requireApproval` + persisted conversation state.
 */

const MAX_DEPTH = 2;
const MAX_HANDOFFS = 5;
const MAX_SNAPSHOT_AGENTS = 12;

export interface AgentSnapshot {
  id: string;
  name: string;
  description: string;
  config: AgentConfig;
}

export interface RunSnapshot {
  root: string;
  agents: Record<string, AgentSnapshot>;
}

interface StoredState {
  agentId: string;
  conversation: string;
}

interface ApprovalDecision {
  approve: string[];
  reject: string[];
}

interface ApprovalGroup {
  callIds: string[];
  decided: Map<string, boolean>;
  resolve(decision: ApprovalDecision): void;
  reject(err: unknown): void;
}

class Cancelled extends Error {}
/** Abort reason used to stop an agent's loop the moment it hands off. */
class HandedOff extends Error {}

type Listener = (event: RunEvent) => void;

const registry = globalThis as unknown as { __orsRuns?: Map<string, RunController>; __orsRunsBooted?: boolean };
const controllers = (registry.__orsRuns ??= new Map<string, RunController>());

/** Runs that were mid-flight when the process died cannot continue: say so instead of showing them as running forever. */
function recoverInterruptedRuns() {
  if (registry.__orsRunsBooted) return;
  registry.__orsRunsBooted = true;
  getDb()
    .update(schema.runs)
    .set({ status: "failed", error: "Interrupted by a server restart.", stopReason: "interrupted", endedAt: Date.now() })
    .where(inArray(schema.runs.status, ["running", "paused"]))
    .run();
}

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  const e = err as { message?: string; body?: string; error?: { message?: string } };
  // SDK HTTP errors carry the raw response body; prefer OpenRouter's own message.
  if (typeof e?.body === "string") {
    try {
      const parsed = JSON.parse(e.body);
      if (parsed?.error?.message) return String(parsed.error.message);
    } catch {
      /* fall through */
    }
  }
  return e?.error?.message ?? e?.message ?? "The run failed.";
}

/** Provider preferences in the camelCase shape the SDK's request type uses. */
function sdkProviderPrefs(r: Routing): Record<string, unknown> | undefined {
  const p = r.provider;
  const out: Record<string, unknown> = {};
  if (p.order.length) out.order = p.order;
  if (p.only.length) out.only = p.only;
  if (p.ignore.length) out.ignore = p.ignore;
  if (!p.allowFallbacks) out.allowFallbacks = false;
  if (p.requireParameters) out.requireParameters = true;
  if (p.sort !== "default") out.sort = p.sort;
  if (p.dataCollection === "deny") out.dataCollection = "deny";
  if (p.zdr) out.zdr = true;
  if (p.quantizations.length) out.quantizations = p.quantizations;
  if (p.maxPromptPrice !== null || p.maxCompletionPrice !== null) {
    out.maxPrice = { ...(p.maxPromptPrice !== null ? { prompt: p.maxPromptPrice } : {}), ...(p.maxCompletionPrice !== null ? { completion: p.maxCompletionPrice } : {}) };
  }
  return Object.keys(out).length ? out : undefined;
}

function parseArgs(raw: unknown): unknown {
  if (typeof raw !== "string") return raw ?? {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

interface AgentOutcome {
  text: string;
  handoff: { to: string; reason: string; context: string } | null;
  /** True when a stop condition ended the loop (rather than the model finishing). */
  bounded: boolean;
}

export class RunController {
  status: RunStatus = "running";
  readonly totals: RunTotals = { steps: 0, promptTokens: 0, completionTokens: 0, cost: 0 };
  private seq = 0;
  private readonly abort = new AbortController();
  private readonly listeners = new Set<Listener>();
  private paused = false;
  private resumeWaiters: (() => void)[] = [];
  private approvals: ApprovalGroup[] = [];
  private readonly approvedCalls = new Set<string>();
  private handoffs = 0;
  private activeAgentId: string;

  constructor(
    readonly id: string,
    readonly accountId: string,
    private readonly apiKey: string,
    private readonly snapshot: RunSnapshot,
    private readonly input: string,
    startSeq = 0,
  ) {
    this.seq = startSeq;
    this.activeAgentId = snapshot.root;
  }

  /* ---------- event log ---------- */

  emit(data: RunEventData): RunEvent {
    const event = { ...data, seq: data.type === "delta" ? this.seq : ++this.seq, ts: Date.now() } as RunEvent;
    // Token deltas are for live viewers only; the complete text is stored as `message`.
    if (data.type !== "delta") {
      const { type, ...rest } = data;
      getDb().insert(schema.runEvents).values({ runId: this.id, seq: event.seq, ts: event.ts, type, data: rest }).run();
    }
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* a broken subscriber must not affect the run */
      }
    }
    return event;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setStatus(status: RunStatus) {
    this.status = status;
    getDb().update(schema.runs).set({ status }).where(eq(schema.runs.id, this.id)).run();
  }

  private saveTotals() {
    getDb()
      .update(schema.runs)
      .set({ steps: this.totals.steps, promptTokens: this.totals.promptTokens, completionTokens: this.totals.completionTokens, cost: this.totals.cost })
      .where(eq(schema.runs.id, this.id))
      .run();
  }

  /* ---------- controls ---------- */

  pause(): boolean {
    if (this.status !== "running") return false;
    this.paused = true;
    this.setStatus("paused");
    this.emit({ type: "run.paused" });
    return true;
  }

  resume(): boolean {
    if (!this.paused) return false;
    this.paused = false;
    this.setStatus("running");
    this.emit({ type: "run.resumed" });
    this.resumeWaiters.splice(0).forEach((fn) => fn());
    return true;
  }

  cancel() {
    this.abort.abort(new Cancelled());
    this.resumeWaiters.splice(0).forEach((fn) => fn());
    this.approvals.splice(0).forEach((g) => g.reject(new Cancelled()));
  }

  /** Records human decisions; a waiting approval group continues once all its calls are decided. */
  decide(decision: ApprovalDecision): number {
    let applied = 0;
    for (const group of [...this.approvals]) {
      for (const id of decision.approve) {
        if (group.callIds.includes(id)) {
          group.decided.set(id, true);
          applied++;
        }
      }
      for (const id of decision.reject) {
        if (group.callIds.includes(id)) {
          group.decided.set(id, false);
          applied++;
        }
      }
      // Calls requested together are answered together: wait until each has a decision.
      if (group.callIds.every((id) => group.decided.has(id))) {
        this.approvals = this.approvals.filter((g) => g !== group);
        group.resolve({
          approve: group.callIds.filter((id) => group.decided.get(id) === true),
          reject: group.callIds.filter((id) => group.decided.get(id) === false),
        });
      }
    }
    return applied;
  }

  private waitIfPaused = async (): Promise<void> => {
    while (this.paused && !this.abort.signal.aborted) {
      await new Promise<void>((resolve) => this.resumeWaiters.push(resolve));
    }
    if (this.abort.signal.aborted) throw new Cancelled();
  };

  private waitForApproval(callIds: string[]): Promise<ApprovalDecision> {
    return new Promise((resolve, reject) => {
      this.approvals.push({ callIds, decided: new Map(), resolve, reject });
    });
  }

  /* ---------- execution ---------- */

  /** Entry point. `resume` continues a run that was waiting for approval when the server restarted. */
  async execute(resume?: { state: StoredState; decision: ApprovalDecision }): Promise<void> {
    const db = getDb();
    try {
      let agent: AgentSnapshot;
      let input: string = this.input;
      let resumeWith: { state: ConversationState; decision: ApprovalDecision } | undefined;

      if (resume) {
        agent = this.snapshot.agents[resume.state.agentId] ?? this.snapshot.agents[this.snapshot.root];
        resumeWith = { state: deserializeConversationState(resume.state.conversation), decision: resume.decision };
        this.setStatus("running");
        this.emit({ type: "notice", level: "info", message: "Resumed after a server restart." });
      } else {
        agent = this.snapshot.agents[this.snapshot.root];
        db.update(schema.runs).set({ startedAt: Date.now() }).where(eq(schema.runs.id, this.id)).run();
        this.emit({ type: "run.started", agent: agent.name, model: agent.config.model, input });
      }

      for (;;) {
        this.activeAgentId = agent.id;
        const outcome = await this.runAgent(agent, input, 0, resumeWith);
        resumeWith = undefined;

        if (outcome.handoff) {
          const target = this.snapshot.agents[outcome.handoff.to];
          if (!target || this.handoffs >= MAX_HANDOFFS) {
            this.finish("completed", outcome.text || outcome.handoff.context, null, this.handoffs >= MAX_HANDOFFS ? "handoff_limit" : "completed");
            return;
          }
          this.handoffs++;
          this.emit({ type: "handoff", from: agent.name, to: target.name, reason: outcome.handoff.reason });
          // The next agent gets the original request plus the briefing its predecessor wrote.
          input = `Original request:\n${this.input}\n\nYou are taking over from the "${agent.name}" agent. Their handoff note:\n${outcome.handoff.context || outcome.handoff.reason}`;
          agent = target;
          continue;
        }

        const budget = agent.config.budgetUsd;
        const stopReason = !outcome.bounded ? "completed" : budget !== null && this.totals.cost >= budget ? "budget" : "max_steps";
        this.finish("completed", outcome.text, null, stopReason);
        return;
      }
    } catch (err) {
      if (err instanceof Cancelled || this.abort.signal.aborted) this.finish("cancelled", null, null, "cancelled");
      else this.finish("failed", null, errorMessage(err), "error");
    }
  }

  private finish(status: "completed" | "failed" | "cancelled", output: string | null, error: string | null, stopReason: string) {
    this.status = status;
    getDb()
      .update(schema.runs)
      .set({ status, output, error, stopReason, endedAt: Date.now(), steps: this.totals.steps, promptTokens: this.totals.promptTokens, completionTokens: this.totals.completionTokens, cost: this.totals.cost })
      .where(eq(schema.runs.id, this.id))
      .run();
    this.emit({ type: "run.finished", status, output, error, stopReason, totals: { ...this.totals } });
    this.listeners.clear();
    controllers.delete(this.id);
  }

  /** An SDK client whose HTTP goes through our retry policy, budget check and failure log. */
  private client(model: string): { client: OpenRouter; lastRetries: () => number } {
    let lastRetries = 0;
    const meta = { accountId: this.accountId, kind: "agent" as const, model, streamed: true, refType: "run" as const, refId: this.id };
    const httpClient = new HTTPClient({
      fetcher: async (input, init) => {
        assertWithinBudget(this.accountId);
        const request = input instanceof Request ? input : new Request(input, init);
        const started = Date.now();
        const path = new URL(request.url).pathname.replace(/^\/api\/v1/, "");
        try {
          const { response, retries } = await retrying(() => fetch(request.clone()), request.signal);
          lastRetries = retries;
          if (!response.ok) {
            // Successful calls are logged with their usage from the PostModelCall hook.
            const text = await response.clone().text().catch(() => "");
            let message = `HTTP ${response.status}`;
            try {
              message = JSON.parse(text)?.error?.message ?? message;
            } catch {
              /* keep the status text */
            }
            writeRequestLog(meta, path, request.method, started, { ok: false, status: response.status, retries, error: message });
          }
          return response;
        } catch (err) {
          if (!request.signal.aborted) writeRequestLog(meta, path, request.method, started, { ok: false, retries: env.maxRetries, error: `network error: ${(err as Error).message}` });
          throw err;
        }
      },
    });
    const client = new OpenRouter({
      apiKey: this.apiKey,
      serverURL: env.openrouterBaseUrl,
      httpReferer: env.appUrl,
      appTitle: "OpenRouter Studio",
      httpClient,
      // Retries are handled above, once, with one policy.
      retryConfig: { strategy: "none" },
    });
    return { client, lastRetries: () => lastRetries };
  }

  private async runAgent(
    agent: AgentSnapshot,
    input: string,
    depth: number,
    resume?: { state: ConversationState; decision: ApprovalDecision },
  ): Promise<AgentOutcome> {
    const config = agent.config;
    const at = { agent: agent.name, depth };
    const host: ToolHost = {
      accountId: this.accountId,
      runId: this.id,
      agent: agent.name,
      depth,
      signal: this.abort.signal,
      emit: (e) => void this.emit(e),
      waitIfPaused: this.waitIfPaused,
      wasApproved: (callId) => this.approvedCalls.has(callId),
    };

    const resolved = await resolveTools(config.tools, config.requireApproval, host);
    for (const message of resolved.warnings) this.emit({ type: "notice", level: "warn", message });
    const tools: Tool[] = [...resolved.tools];
    const sources = new Map<string, ToolSource>(resolved.sources);
    const used = new Set(sources.keys());
    const unique = (base: string) => {
      let name = base;
      for (let i = 2; used.has(name); i++) name = `${base}_${i}`;
      used.add(name);
      return name;
    };

    // Sub-agents: called like a tool, run their own loop, and return their answer.
    if (depth < MAX_DEPTH) {
      for (const id of config.subAgents) {
        const sub = this.snapshot.agents[id];
        if (!sub) continue;
        const name = unique(`ask_${slugify(sub.name)}`);
        sources.set(name, "agent");
        tools.push(
          toSdkTool(
            {
              name,
              description: `Delegate a task to the "${sub.name}" agent and get its answer back. ${sub.description}`.trim(),
              source: "agent",
              inputSchema: z.object({ task: z.string().describe("A complete, self-contained description of what you need. The agent cannot see this conversation.") }),
              timeoutMs: 15 * 60_000,
              run: async (args, ctx) => {
                const { task } = args as { task: string };
                this.emit({ type: "subagent.started", agent: sub.name, depth: depth + 1, parentCallId: ctx.callId, task });
                const out = await this.runAgent(sub, task, depth + 1);
                this.emit({ type: "subagent.finished", agent: sub.name, depth: depth + 1, parentCallId: ctx.callId, output: out.text });
                return { answer: out.text };
              },
            },
            host,
            false,
          ),
        );
      }
    }

    // Handoffs: transfer the whole task to another agent. Only the top-level agent may.
    let handoff: AgentOutcome["handoff"] = null;
    // Aborting this (and only this) loop when a handoff is recorded stops the SDK before
    // it spends another model call on an agent that is no longer in charge.
    const loopAbort = new AbortController();
    if (depth === 0) {
      for (const id of config.handoffs) {
        const target = this.snapshot.agents[id];
        if (!target) continue;
        const name = unique(`handoff_to_${slugify(target.name)}`);
        sources.set(name, "agent");
        tools.push(
          toSdkTool(
            {
              name,
              description: `Hand this entire task over to the "${target.name}" agent and stop. Use when it is better suited to finish the job. ${target.description}`.trim(),
              source: "agent",
              inputSchema: z.object({
                reason: z.string().describe("Why you are handing off."),
                context: z.string().describe("Everything the next agent needs: what was asked, what you found, what remains."),
              }),
              run: async (args) => {
                const a = args as { reason: string; context: string };
                handoff = { to: id, reason: a.reason, context: a.context };
                return { ok: true, note: `Control transferred to ${target.name}.` };
              },
              // Stop this agent's loop before the SDK can start another turn.
              onSettled: () => {
                if (handoff) loopAbort.abort(new HandedOff());
              },
            },
            host,
            false,
          ),
        );
      }
    }

    // Conversation state. For the top-level agent it is persisted so an approval can outlive a restart.
    let state: ConversationState | null = resume?.state ?? null;
    const accessor: StateAccessor = {
      load: async () => state,
      save: async (next) => {
        state = next;
        if (depth === 0) {
          const stored: StoredState = { agentId: agent.id, conversation: serializeConversationState(next) };
          getDb().update(schema.runs).set({ state: JSON.stringify(stored) }).where(eq(schema.runs.id, this.id)).run();
        }
      },
    };

    const { client, lastRetries } = this.client(config.model);
    let bounded = false;
    // The SDK counts completed tool rounds and checks after the *next* response, so
    // stepCountIs(n) permits n + 1 tool-using model calls. Offset by one so that
    // maxSteps means what it says: at most that many tool-using steps, then a closing answer.
    const stopWhen: StopCondition[] = [stepCountIs(config.maxSteps - 1)];
    if (config.budgetUsd !== null) {
      const budget = config.budgetUsd;
      // maxCost bounds this loop; the second condition also counts what sub-agents spent.
      stopWhen.push(maxCost(budget), () => this.totals.cost >= budget);
    }

    const base = {
      ...toModelFields(config.model, config.routing),
      instructions: config.instructions || undefined,
      tools,
      stopWhen,
      temperature: config.temperature ?? undefined,
      maxOutputTokens: config.maxOutputTokens ?? undefined,
      reasoning: config.reasoningEffort ? { effort: config.reasoningEffort } : undefined,
      provider: sdkProviderPrefs(config.routing),
      state: accessor,
      signal: AbortSignal.any([this.abort.signal, loopAbort.signal]),
      onTurnStart: async () => {
        await this.waitIfPaused();
      },
      hooks: {
        PostModelCall: [
          {
            handler: async (p: { responseId: string; model: string; durationMs: number; turnType: string; usage?: { inputTokens: number; outputTokens: number; cachedTokens: number; reasoningTokens: number; cost?: number } }) => {
              // The SDK labels the extra answer-only turn it makes after a stop condition fires.
              if (p.turnType === "final") bounded = true;
              const usage = {
                promptTokens: p.usage?.inputTokens ?? 0,
                completionTokens: p.usage?.outputTokens ?? 0,
                reasoningTokens: p.usage?.reasoningTokens ?? 0,
                cachedTokens: p.usage?.cachedTokens ?? 0,
                cost: p.usage?.cost ?? null,
              };
              this.totals.steps++;
              this.totals.promptTokens += usage.promptTokens;
              this.totals.completionTokens += usage.completionTokens;
              this.totals.cost += usage.cost ?? 0;
              this.saveTotals();
              const durationMs = Math.round(p.durationMs);
              writeRequestLog(
                { accountId: this.accountId, kind: "agent", model: config.model, streamed: true, refType: "run", refId: this.id },
                "/responses",
                "POST",
                Date.now() - durationMs,
                { ok: true, status: 200, latencyMs: durationMs, retries: lastRetries(), modelUsed: p.model, generationId: p.responseId, ...usage },
              );
              this.emit({ type: "step.finished", ...at, step: this.totals.steps, model: p.model, turnType: p.turnType, durationMs, usage });
            },
          },
        ],
      },
    };

    try {
      let request: Record<string, unknown> = { ...base, input };
      if (resume) request = { ...base, input: [], approveToolCalls: resume.decision.approve, rejectToolCalls: resume.decision.reject };

      for (;;) {
        if (this.abort.signal.aborted) throw new Cancelled();
        const result = client.callModel(request as unknown as Parameters<OpenRouter["callModel"]>[0]);

        try {
          for await (const ev of result.getFullResponsesStream()) {
            const e = ev as { type: string; delta?: unknown; item?: Record<string, unknown> };
            if (e.type === "turn.start") {
              this.emit({ type: "step.started", ...at, step: this.totals.steps + 1 });
            } else if (e.type === "response.output_text.delta" && typeof e.delta === "string") {
              this.emit({ type: "delta", ...at, kind: "text", text: e.delta });
            } else if (/^response\.reasoning.*\.delta$/.test(e.type) && typeof e.delta === "string") {
              this.emit({ type: "delta", ...at, kind: "reasoning", text: e.delta });
            } else if (e.type === "response.output_item.done" && e.item) {
              this.onItem(e.item, at, sources, resolved.approvalNames);
            }
          }
        } catch (err) {
          // The loop was stopped on purpose by a handoff; a user cancel still propagates.
          if (!handoff || this.abort.signal.aborted) throw err;
        }
        if (handoff) return { text: "", handoff, bounded: false };

        if (await result.requiresApproval()) {
          const pending = (await result.getPendingToolCalls()) as { id: string; name: string; arguments: unknown }[];
          const calls = pending.map((c) => ({ id: c.id, name: c.name, args: c.arguments }));
          this.setStatus("awaiting_approval");
          this.emit({ type: "approval.requested", ...at, calls });
          const decision = await this.waitForApproval(calls.map((c) => c.id));
          if (this.abort.signal.aborted) throw new Cancelled();

          decision.approve.forEach((id) => this.approvedCalls.add(id));
          this.emit({ type: "approval.resolved", approved: decision.approve, rejected: decision.reject });
          for (const call of calls.filter((c) => decision.reject.includes(c.id))) {
            const result = { error: "rejected", message: "A human reviewer declined this tool call." };
            logToolCall({ accountId: this.accountId, runId: this.id, agentName: agent.name, toolName: call.name, source: sources.get(call.name) ?? "builtin", args: call.args, result, status: "rejected", approval: "rejected", durationMs: 0 });
            this.emit({ type: "tool.result", ...at, callId: call.id, name: call.name, status: "rejected", result, durationMs: 0 });
          }
          // Another approval elsewhere in the tree may still be open.
          this.setStatus(this.approvals.length ? "awaiting_approval" : this.paused ? "paused" : "running");
          request = { ...base, input: [], approveToolCalls: decision.approve, rejectToolCalls: decision.reject };
          continue;
        }

        const text = await result.getText();
        return { text, handoff: null, bounded };
      }
    } finally {
      await resolved.close();
    }
  }

  /** Translates a completed output item from the model into trace events. */
  private onItem(item: Record<string, unknown>, at: { agent: string; depth: number }, sources: Map<string, ToolSource>, approvalNames: Set<string>) {
    if (item.type === "message" && Array.isArray(item.content)) {
      const text = item.content.map((part: { type?: string; text?: string }) => (part.type === "output_text" ? (part.text ?? "") : "")).join("");
      if (text) this.emit({ type: "message", ...at, text });
    } else if (item.type === "reasoning") {
      const parts = [...(Array.isArray(item.summary) ? item.summary : []), ...(Array.isArray(item.content) ? item.content : [])];
      const text = parts.map((part: { text?: string }) => part.text ?? "").join("\n").trim();
      if (text) this.emit({ type: "reasoning", ...at, text });
    } else if (item.type === "function_call") {
      const name = String(item.name);
      this.emit({
        type: "tool.call",
        ...at,
        callId: String(item.callId ?? item.id),
        name,
        source: sources.get(name) ?? "builtin",
        args: parseArgs(item.arguments),
        requiresApproval: approvalNames.has(name),
      });
    }
  }
}

/* ---------- public API ---------- */

/** Freezes the agent and every agent it can reach, so a run is reproducible later. */
export function buildSnapshot(accountId: string, rootId: string): RunSnapshot {
  const db = getDb();
  const agents: Record<string, AgentSnapshot> = {};
  const queue = [rootId];
  while (queue.length && Object.keys(agents).length < MAX_SNAPSHOT_AGENTS) {
    const id = queue.shift()!;
    if (agents[id]) continue;
    const row = db.select().from(schema.agents).where(and(eq(schema.agents.id, id), eq(schema.agents.accountId, accountId))).get();
    if (!row) {
      if (id === rootId) throw new ApiError(404, "not_found", "Agent not found.");
      continue;
    }
    const config = agentConfigSchema.parse(row.config);
    agents[id] = { id, name: row.name, description: row.description, config };
    queue.push(...config.subAgents, ...config.handoffs);
  }
  return { root: rootId, agents };
}

export function startRun(opts: { accountId: string; apiKey: string; snapshot: RunSnapshot; input: string; agentId: string | null; replayOf?: string }): string {
  recoverInterruptedRuns();
  const id = newId("run");
  const root = opts.snapshot.agents[opts.snapshot.root];
  getDb()
    .insert(schema.runs)
    .values({
      id,
      accountId: opts.accountId,
      agentId: opts.agentId,
      agentName: root.name,
      snapshot: opts.snapshot as unknown as Record<string, unknown>,
      replayOf: opts.replayOf ?? null,
      input: opts.input,
      status: "running",
    })
    .run();
  const controller = new RunController(id, opts.accountId, opts.apiKey, opts.snapshot, opts.input);
  controllers.set(id, controller);
  void controller.execute();
  return id;
}

/**
 * Forgets a live run without finishing it, which is exactly what a process restart does
 * to in-memory state. Used by tests to exercise recovery.
 */
export function dropLiveRun(runId: string): void {
  controllers.delete(runId);
}

export function getController(runId: string): RunController | undefined {
  return controllers.get(runId);
}

export function getRunRow(accountId: string, runId: string) {
  recoverInterruptedRuns();
  const row = getDb().select().from(schema.runs).where(and(eq(schema.runs.id, runId), eq(schema.runs.accountId, accountId))).get();
  if (!row) throw new ApiError(404, "not_found", "Run not found.");
  return row;
}

export function listEvents(runId: string, afterSeq = 0): RunEvent[] {
  return getDb()
    .select()
    .from(schema.runEvents)
    .where(and(eq(schema.runEvents.runId, runId), gt(schema.runEvents.seq, afterSeq)))
    .orderBy(asc(schema.runEvents.seq))
    .all()
    .map((row) => ({ ...(row.data as object), type: row.type, seq: row.seq, ts: row.ts }) as RunEvent);
}

/**
 * Applies an approval decision. Normally the run is live and simply continues. If the
 * server restarted while it was waiting, the run is rebuilt from its persisted
 * conversation state and resumed.
 */
export function decideApproval(accountId: string, apiKey: string, runId: string, decision: ApprovalDecision): void {
  const row = getRunRow(accountId, runId);
  const live = controllers.get(runId);
  if (live) {
    if (live.decide(decision) === 0) throw new ApiError(409, "nothing_pending", "Those tool calls are not waiting for approval.");
    return;
  }
  if (row.status !== "awaiting_approval" || !row.state) throw new ApiError(409, "not_waiting", "This run is not waiting for approval.");
  const lastSeq = listEvents(runId).at(-1)?.seq ?? 0;
  const controller = new RunController(runId, accountId, apiKey, row.snapshot as unknown as RunSnapshot, row.input, lastSeq);
  controllers.set(runId, controller);
  controller.emit({ type: "approval.resolved", approved: decision.approve, rejected: decision.reject });
  void controller.execute({ state: JSON.parse(row.state) as StoredState, decision });
}

export function cancelRun(accountId: string, runId: string): void {
  const row = getRunRow(accountId, runId);
  const live = controllers.get(runId);
  if (live) return live.cancel();
  if (!isTerminal(row.status)) {
    // No live controller (e.g. it was waiting for approval across a restart): close it out directly.
    getDb().update(schema.runs).set({ status: "cancelled", stopReason: "cancelled", endedAt: Date.now() }).where(eq(schema.runs.id, runId)).run();
  }
}
