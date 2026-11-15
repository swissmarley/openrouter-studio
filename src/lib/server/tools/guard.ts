import "server-only";
import { tool, type Tool } from "@openrouter/agent";
import { getDb, schema } from "@/db";
import type { ToolSource, ToolStatus } from "@/lib/shared/runs";
import { newId } from "../crypto";
import { getSettings } from "../settings";
import type { ToolHost, ToolSpec } from "./types";

/**
 * Every tool call (built-in, custom, MCP, sub-agent) goes through `guarded`, which
 * applies, in order: the pause gate, the per-account rate limit, a deadline, result size
 * limits, an audit-log row, and trace events. Tool failures are returned to the model as
 * `{ error }` values rather than thrown, so one bad call does not end the run.
 */

const MAX_RESULT_CHARS = 30_000;
const DEFAULT_TIMEOUT_MS = 60_000;

// Sliding one-minute window of call timestamps per account.
const windows = (globalThis as unknown as { __orsToolWindows?: Map<string, number[]> }).__orsToolWindows ??= new Map<string, number[]>();

export function takeRateLimitSlot(accountId: string, limitPerMin: number, now = Date.now()): { ok: true } | { ok: false; retryAfterMs: number } {
  const cutoff = now - 60_000;
  const recent = (windows.get(accountId) ?? []).filter((t) => t > cutoff);
  if (recent.length >= limitPerMin) {
    windows.set(accountId, recent);
    return { ok: false, retryAfterMs: Math.max(1, recent[0] + 60_000 - now) };
  }
  recent.push(now);
  windows.set(accountId, recent);
  return { ok: true };
}

export function resetRateLimits() {
  windows.clear();
}

function preview(value: unknown, max: number): string {
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  return text === undefined ? "" : text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Keeps a tool result from flooding the model's context window. */
function clamp(result: unknown): unknown {
  const text = preview(result, Number.MAX_SAFE_INTEGER);
  if (text.length <= MAX_RESULT_CHARS) return result;
  return { truncated: true, note: `Result was ${text.length} characters; showing the first ${MAX_RESULT_CHARS}.`, preview: text.slice(0, MAX_RESULT_CHARS) };
}

export function logToolCall(row: {
  accountId: string;
  runId: string | null;
  agentName: string | null;
  toolName: string;
  source: ToolSource;
  args: unknown;
  result: unknown;
  status: ToolStatus;
  approval: "auto" | "approved" | "rejected";
  durationMs: number;
}) {
  try {
    getDb()
      .insert(schema.toolCalls)
      .values({
        id: newId("tc"),
        accountId: row.accountId,
        runId: row.runId,
        agentName: row.agentName,
        toolName: row.toolName,
        source: row.source,
        args: preview(row.args, 10_000),
        result: preview(row.result, 4000),
        status: row.status,
        approval: row.approval,
        durationMs: row.durationMs,
        ts: Date.now(),
      })
      .run();
  } catch (err) {
    console.error("[tools] failed to write tool-call log", err);
  }
}

class ToolTimeout extends Error {}

export interface GuardedCall {
  name: string;
  source: ToolSource;
  timeoutMs?: number;
  args: unknown;
  callId: string;
  /** Receives a signal that fires on run cancel or timeout. */
  execute(signal: AbortSignal): Promise<unknown>;
}

/** Runs one tool call under all the harness's protections and returns what the model should see. */
export async function guarded(host: ToolHost, call: GuardedCall): Promise<unknown> {
  await host.waitIfPaused();
  const started = Date.now();
  const approval = host.wasApproved(call.callId) ? "approved" : "auto";

  const finish = (status: ToolStatus, result: unknown) => {
    const durationMs = Date.now() - started;
    logToolCall({ accountId: host.accountId, runId: host.runId, agentName: host.agent, toolName: call.name, source: call.source, args: call.args, result, status, approval, durationMs });
    host.emit({ type: "tool.result", agent: host.agent, depth: host.depth, callId: call.callId, name: call.name, status, result, durationMs });
    return result;
  };

  if (host.signal.aborted) return finish("error", { error: "The run was cancelled before this tool ran." });

  const limit = takeRateLimitSlot(host.accountId, getSettings(host.accountId).tools.rateLimitPerMin);
  if (!limit.ok) {
    return finish("rate_limited", {
      error: "rate_limited",
      message: `Tool rate limit reached. Try again in ${Math.ceil(limit.retryAfterMs / 1000)}s, or finish with what you have.`,
    });
  }

  const timeoutMs = call.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new ToolTimeout()), timeoutMs);
  const signal = AbortSignal.any([host.signal, deadline.signal]);
  try {
    const result = await Promise.race([
      call.execute(signal),
      new Promise<never>((_, reject) => {
        signal.addEventListener("abort", () => reject(deadline.signal.aborted ? new ToolTimeout() : new Error("The run was cancelled.")), { once: true });
      }),
    ]);
    return finish("ok", clamp(result));
  } catch (err) {
    if (err instanceof ToolTimeout) return finish("timeout", { error: "tool_timeout", message: `The tool did not finish within ${timeoutMs}ms.` });
    return finish("error", { error: (err as Error).message || "The tool failed." });
  } finally {
    clearTimeout(timer);
  }
}

interface SdkToolContext {
  callId?: string;
  toolCall?: { callId?: string; id?: string };
  signal?: AbortSignal;
}

/**
 * The model's id for this call. The SDK always threads the originating call through
 * `toolCall`; `callId` is only set on some paths (not when resuming after approval).
 */
function callIdOf(ctx: SdkToolContext | undefined): string {
  return ctx?.toolCall?.callId ?? ctx?.callId ?? ctx?.toolCall?.id ?? newId("call");
}

/** Wraps one of our tool specs as an Agent SDK tool. */
export function toSdkTool(spec: ToolSpec, host: ToolHost, requireApproval: boolean): Tool {
  return tool({
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema,
    requireApproval,
    execute: async (args: unknown, ctx?: unknown) => {
      const callId = callIdOf(ctx as SdkToolContext | undefined);
      const result = await guarded(host, {
        name: spec.name,
        source: spec.source,
        timeoutMs: spec.timeoutMs,
        args,
        callId,
        execute: (signal) => spec.run(args, { accountId: host.accountId, runId: host.runId, signal, callId }),
      });
      // Runs after the call is logged and before control returns to the SDK loop.
      spec.onSettled?.();
      return result;
    },
  }) as Tool;
}

type ExecutableTool = Tool & {
  function: { name: string; execute: (args: unknown, ctx?: unknown) => unknown; requireApproval?: unknown; eventSchema?: unknown };
};

const isAsyncIterable = (v: unknown): v is AsyncIterable<unknown> =>
  typeof v === "object" && v !== null && typeof (v as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function";

/**
 * Runs an SDK tool's own execute to a single final value. MCP tools are generator tools
 * (progress events, then the result): per the SDK's contract the result is the returned
 * value if there is one, otherwise the last value yielded.
 */
async function settle(out: unknown): Promise<unknown> {
  if (!isAsyncIterable(out)) return await out;
  const iterator = out[Symbol.asyncIterator]();
  let last: unknown;
  for (;;) {
    const step = await iterator.next();
    if (step.done) return step.value !== undefined ? step.value : last;
    last = step.value;
  }
}

/**
 * Puts an existing SDK tool (one produced by the SDK's MCP client) behind the same guard,
 * keeping its schema and MCP branding intact.
 */
export function guardSdkTool(original: Tool, source: ToolSource, host: ToolHost, requireApproval: boolean): Tool {
  const inner = original as ExecutableTool;
  const execute = inner.function.execute.bind(inner.function);
  const run = (args: unknown, ctx?: unknown) => {
    const callId = callIdOf(ctx as SdkToolContext | undefined);
    return guarded(host, { name: inner.function.name, source, args, callId, execute: () => settle(execute(args, ctx)) });
  };
  return {
    ...inner,
    function: {
      ...inner.function,
      requireApproval,
      // The SDK decides how to call a tool from its shape, so a generator tool stays one:
      // it yields exactly once, with the guarded final result.
      execute: inner.function.eventSchema
        ? async function* (args: unknown, ctx?: unknown) {
            yield await run(args, ctx);
          }
        : run,
    },
  } as Tool;
}
