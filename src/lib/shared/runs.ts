import { z } from "zod";

/** Run records and the trace event vocabulary, shared by the harness and the trace UI. */

export type RunStatus = "running" | "paused" | "awaiting_approval" | "completed" | "failed" | "cancelled";

export const TERMINAL_STATUSES: RunStatus[] = ["completed", "failed", "cancelled"];
export const isTerminal = (status: string) => (TERMINAL_STATUSES as string[]).includes(status);

export interface StepUsage {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  cost: number | null;
}

export interface RunTotals {
  steps: number;
  promptTokens: number;
  completionTokens: number;
  cost: number;
}

export type ToolSource = "builtin" | "custom" | "mcp" | "agent";
export type ToolStatus = "ok" | "error" | "rejected" | "rate_limited" | "timeout";

/** Where in the agent tree an event happened. depth 0 is the agent the run was started with. */
interface At {
  agent: string;
  depth: number;
}

export type RunEventData =
  | { type: "run.started"; agent: string; model: string; input: string }
  | ({ type: "step.started"; step: number } & At)
  /** Streamed text. Sent live but never stored; the full text arrives as `message`. */
  | ({ type: "delta"; kind: "text" | "reasoning"; text: string } & At)
  | ({ type: "message"; text: string } & At)
  | ({ type: "reasoning"; text: string } & At)
  | ({ type: "tool.call"; callId: string; name: string; source: ToolSource; args: unknown; requiresApproval: boolean } & At)
  | ({ type: "tool.result"; callId: string; name: string; status: ToolStatus; result: unknown; durationMs: number } & At)
  | ({ type: "step.finished"; step: number; model: string; turnType: string; durationMs: number; usage: StepUsage } & At)
  | ({ type: "approval.requested"; calls: { id: string; name: string; args: unknown }[] } & At)
  | { type: "approval.resolved"; approved: string[]; rejected: string[] }
  | { type: "handoff"; from: string; to: string; reason: string }
  | ({ type: "subagent.started"; parentCallId: string; task: string } & At)
  | ({ type: "subagent.finished"; parentCallId: string; output: string } & At)
  | { type: "run.paused" }
  | { type: "run.resumed" }
  | { type: "notice"; level: "info" | "warn"; message: string }
  | { type: "run.finished"; status: "completed" | "failed" | "cancelled"; output: string | null; error: string | null; stopReason: string; totals: RunTotals };

export type RunEvent = RunEventData & { seq: number; ts: number };

export interface RunSummary {
  id: string;
  agentId: string | null;
  agentName: string;
  input: string;
  status: RunStatus;
  output: string | null;
  error: string | null;
  stopReason: string | null;
  replayOf: string | null;
  steps: number;
  promptTokens: number;
  completionTokens: number;
  cost: number;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
}

export const startRunSchema = z.object({
  agentId: z.string().min(1).max(80),
  input: z.string().trim().min(1, "Give the agent something to do.").max(200_000),
});

export const approvalSchema = z.object({
  approve: z.array(z.string().min(1).max(200)).max(50).default([]),
  reject: z.array(z.string().min(1).max(200)).max(50).default([]),
});
