"use client";

import { useMemo, useState, type ReactNode } from "react";
import { ArrowRightLeft, Bot, Check, ChevronRight, CircleAlert, Clock, Hand, Info, Pause, Play, User, Wrench, X } from "lucide-react";
import { cx, duration, tokens, usd } from "@/lib/shared/format";
import type { RunEvent, ToolSource, ToolStatus } from "@/lib/shared/runs";
import { Markdown } from "../markdown";
import { Badge, Button, Spinner } from "../ui";

type Of<T extends RunEvent["type"]> = Extract<RunEvent, { type: T }>;

interface ToolItem {
  kind: "tool";
  key: string;
  depth: number;
  agent: string;
  callId: string;
  name: string;
  source: ToolSource;
  args: unknown;
  requiresApproval: boolean;
  /** undefined while the call has not finished. */
  result?: { status: ToolStatus; value: unknown; durationMs: number };
  approval?: "pending" | "approved" | "rejected";
  ts: number;
}

type Item =
  | ToolItem
  | { kind: "input"; key: string; depth: 0; text: string; agent: string; model: string }
  | { kind: "message"; key: string; depth: number; agent: string; text: string }
  | { kind: "reasoning"; key: string; depth: number; agent: string; text: string }
  | { kind: "step"; key: string; depth: number; event: Of<"step.finished"> }
  | { kind: "handoff"; key: string; depth: 0; from: string; to: string; reason: string }
  | { kind: "subagent"; key: string; depth: number; agent: string; task: string; done: boolean }
  | { kind: "marker"; key: string; depth: 0; icon: "pause" | "play" | "info" | "warn"; text: string }
  | { kind: "finish"; key: string; depth: 0; event: Of<"run.finished"> };

/** Folds the flat event log into what the timeline shows: a tool call and its result become one card. */
export function buildTimeline(events: RunEvent[]): { items: Item[]; pendingApprovals: string[] } {
  const items: Item[] = [];
  const tools = new Map<string, ToolItem>();
  const pending = new Set<string>();

  for (const e of events) {
    const key = `e${e.seq}`;
    switch (e.type) {
      case "run.started":
        items.push({ kind: "input", key, depth: 0, text: e.input, agent: e.agent, model: e.model });
        break;
      case "message":
        items.push({ kind: "message", key, depth: e.depth, agent: e.agent, text: e.text });
        break;
      case "reasoning":
        items.push({ kind: "reasoning", key, depth: e.depth, agent: e.agent, text: e.text });
        break;
      case "tool.call": {
        const item: ToolItem = { kind: "tool", key, depth: e.depth, agent: e.agent, callId: e.callId, name: e.name, source: e.source, args: e.args, requiresApproval: e.requiresApproval, ts: e.ts };
        tools.set(e.callId, item);
        items.push(item);
        break;
      }
      case "tool.result": {
        const item = tools.get(e.callId);
        const result = { status: e.status, value: e.result, durationMs: e.durationMs };
        if (item) item.result = result;
        else items.push({ kind: "tool", key, depth: e.depth, agent: e.agent, callId: e.callId, name: e.name, source: "builtin", args: undefined, requiresApproval: false, result, ts: e.ts });
        break;
      }
      case "approval.requested":
        for (const call of e.calls) {
          pending.add(call.id);
          const item = tools.get(call.id);
          if (item) item.approval = "pending";
        }
        break;
      case "approval.resolved":
        for (const id of e.approved) {
          pending.delete(id);
          const item = tools.get(id);
          if (item) item.approval = "approved";
        }
        for (const id of e.rejected) {
          pending.delete(id);
          const item = tools.get(id);
          if (item) item.approval = "rejected";
        }
        break;
      case "step.finished":
        items.push({ kind: "step", key, depth: e.depth, event: e });
        break;
      case "handoff":
        items.push({ kind: "handoff", key, depth: 0, from: e.from, to: e.to, reason: e.reason });
        break;
      case "subagent.started":
        items.push({ kind: "subagent", key, depth: e.depth, agent: e.agent, task: e.task, done: false });
        break;
      case "subagent.finished":
        items.push({ kind: "subagent", key, depth: e.depth, agent: e.agent, task: "", done: true });
        break;
      case "run.paused":
        items.push({ kind: "marker", key, depth: 0, icon: "pause", text: "Paused" });
        break;
      case "run.resumed":
        items.push({ kind: "marker", key, depth: 0, icon: "play", text: "Resumed" });
        break;
      case "notice":
        items.push({ kind: "marker", key, depth: 0, icon: e.level === "warn" ? "warn" : "info", text: e.message });
        break;
      case "run.finished": {
        // The closing message is the final answer; show it once, in the summary card.
        for (let i = items.length - 1; i >= 0; i--) {
          const prev = items[i];
          if (prev.kind === "step" || prev.kind === "marker") continue;
          if (prev.kind === "message" && prev.depth === 0 && prev.text === e.output) items.splice(i, 1);
          break;
        }
        items.push({ kind: "finish", key, depth: 0, event: e });
        break;
      }
    }
  }
  return { items, pendingApprovals: [...pending] };
}

function Json({ value, label }: { value: unknown; label: string }) {
  const text = useMemo(() => {
    if (value === undefined) return "";
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }, [value]);
  const [open, setOpen] = useState(text.length <= 400);
  if (!text) return null;
  return (
    <div>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex items-center gap-1 text-[11px] font-medium text-muted hover:text-fg">
        <ChevronRight className={cx("size-3 transition-transform", open && "rotate-90")} aria-hidden />
        {label}
        {!open ? <span className="font-normal text-faint">({text.length.toLocaleString()} chars)</span> : null}
      </button>
      {open ? <pre className="mt-1 max-h-72 overflow-auto rounded border border-line bg-subtle p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">{text}</pre> : null}
    </div>
  );
}

const sourceLabel: Record<ToolSource, string> = { builtin: "built-in", custom: "custom", mcp: "MCP", agent: "agent" };

const statusTone: Record<ToolStatus, "ok" | "err" | "warn"> = { ok: "ok", error: "err", rejected: "warn", rate_limited: "warn", timeout: "err" };

function ToolCard({
  item,
  live,
  onDecide,
  deciding,
}: {
  item: ToolItem;
  live: boolean;
  onDecide?: (callId: string, approve: boolean) => void;
  deciding: boolean;
}) {
  const waiting = item.approval === "pending";
  return (
    <div className={cx("rounded-md border bg-panel", waiting ? "border-warn" : "border-line")}>
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <Wrench className="size-3.5 shrink-0 text-muted" aria-hidden />
        <span className="font-mono text-xs font-semibold">{item.name}</span>
        <Badge>{sourceLabel[item.source]}</Badge>
        {item.approval === "approved" ? <Badge tone="ok">approved</Badge> : null}
        <span className="ml-auto flex items-center gap-2 text-[11px] text-faint">
          {item.result ? (
            <>
              <Badge tone={statusTone[item.result.status]}>{item.result.status.replace("_", " ")}</Badge>
              <span className="tabular">{duration(item.result.durationMs)}</span>
            </>
          ) : waiting ? (
            <Badge tone="warn">
              <Hand className="size-3" aria-hidden /> needs approval
            </Badge>
          ) : live ? (
            <span className="flex items-center gap-1.5">
              <Spinner className="size-3" /> running
            </span>
          ) : (
            <span>no result recorded</span>
          )}
        </span>
      </div>
      <div className="space-y-2 border-t border-line px-3 py-2">
        <Json value={item.args} label="Arguments" />
        {item.result ? <Json value={item.result.value} label="Result" /> : null}
        {waiting && onDecide ? (
          <div className="flex items-center gap-2 pt-1">
            <Button size="sm" variant="primary" icon={<Check className="size-3.5" />} disabled={deciding} onClick={() => onDecide(item.callId, true)}>
              Approve
            </Button>
            <Button size="sm" variant="danger" icon={<X className="size-3.5" />} disabled={deciding} onClick={() => onDecide(item.callId, false)}>
              Reject
            </Button>
            <span className="text-[11px] text-faint">The agent is waiting. Nothing runs until you decide.</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Row({ depth, children }: { depth: number; children: ReactNode }) {
  // Sub-agent activity is inset with a rail so the nesting reads at a glance.
  return <div style={{ marginLeft: depth * 20 }} className={cx(depth > 0 && "border-l-2 border-accent-soft pl-3")}>{children}</div>;
}

function StepLine({ event }: { event: Of<"step.finished"> }) {
  const u = event.usage;
  return (
    <p className="tabular flex flex-wrap items-center gap-x-2 text-[11px] text-faint">
      <Clock className="size-3" aria-hidden />
      <span>
        Step {event.step}
        {event.turnType === "final" ? " (closing answer)" : ""}
      </span>
      <span className="font-mono">{event.model}</span>
      <span>{duration(event.durationMs)}</span>
      <span>
        {tokens(u.promptTokens)} in → {tokens(u.completionTokens)} out
      </span>
      {u.reasoningTokens ? <span>{tokens(u.reasoningTokens)} reasoning</span> : null}
      {u.cachedTokens ? <span>{tokens(u.cachedTokens)} cached</span> : null}
      {u.cost !== null ? <span>{usd(u.cost)}</span> : null}
    </p>
  );
}

const STOP_REASONS: Record<string, string> = {
  completed: "The agent finished on its own.",
  max_steps: "Stopped at the step limit; the agent gave a closing answer.",
  budget: "Stopped at the budget cap; the agent gave a closing answer.",
  handoff_limit: "Stopped after too many handoffs.",
  cancelled: "Cancelled.",
  error: "Failed.",
  interrupted: "Interrupted by a server restart.",
};

export function Trace({
  events,
  streaming,
  live,
  onDecide,
  deciding = false,
}: {
  events: RunEvent[];
  streaming: Record<string, { text: string; reasoning: string }>;
  live: boolean;
  onDecide?: (callId: string, approve: boolean) => void;
  deciding?: boolean;
}) {
  const { items } = useMemo(() => buildTimeline(events), [events]);
  const liveText = Object.entries(streaming).filter(([, v]) => v.text || v.reasoning);

  return (
    <ol className="space-y-3">
      {items.map((item) => {
        switch (item.kind) {
          case "input":
            return (
              <li key={item.key}>
                <div className="rounded-md bg-accent-soft px-3 py-2">
                  <p className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-accent-text">
                    <User className="size-3" aria-hidden /> Task for {item.agent} <span className="font-mono font-normal opacity-80">{item.model}</span>
                  </p>
                  <p className="text-[13px] whitespace-pre-wrap">{item.text}</p>
                </div>
              </li>
            );
          case "message":
            return (
              <li key={item.key}>
                <Row depth={item.depth}>
                  <p className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-muted">
                    <Bot className="size-3" aria-hidden /> {item.agent}
                  </p>
                  <Markdown text={item.text} />
                </Row>
              </li>
            );
          case "reasoning":
            return (
              <li key={item.key}>
                <Row depth={item.depth}>
                  <details className="rounded-md border border-line bg-subtle">
                    <summary className="cursor-pointer px-2.5 py-1.5 text-xs text-muted select-none">Reasoning ({item.agent})</summary>
                    <p className="max-h-60 overflow-y-auto px-2.5 pb-2 text-xs leading-relaxed whitespace-pre-wrap text-muted">{item.text}</p>
                  </details>
                </Row>
              </li>
            );
          case "tool":
            return (
              <li key={item.key}>
                <Row depth={item.depth}>
                  <ToolCard item={item} live={live} onDecide={onDecide} deciding={deciding} />
                </Row>
              </li>
            );
          case "step":
            return (
              <li key={item.key}>
                <Row depth={item.depth}>
                  <StepLine event={item.event} />
                </Row>
              </li>
            );
          case "handoff":
            return (
              <li key={item.key} className="flex items-center gap-2 py-1 text-xs text-muted">
                <span className="h-px flex-1 bg-line" />
                <ArrowRightLeft className="size-3.5 text-accent-text" aria-hidden />
                <span>
                  <strong className="font-medium text-fg">{item.from}</strong> handed off to <strong className="font-medium text-fg">{item.to}</strong>
                  {item.reason ? `: ${item.reason}` : ""}
                </span>
                <span className="h-px flex-1 bg-line" />
              </li>
            );
          case "subagent":
            return (
              <li key={item.key}>
                <Row depth={item.depth}>
                  <p className="text-[11px] font-medium text-accent-text">
                    {item.done ? `${item.agent} returned its answer` : `Sub-agent ${item.agent} started`}
                  </p>
                  {item.task ? <p className="mt-0.5 text-xs whitespace-pre-wrap text-muted">{item.task}</p> : null}
                </Row>
              </li>
            );
          case "marker": {
            const Icon = item.icon === "pause" ? Pause : item.icon === "play" ? Play : item.icon === "warn" ? CircleAlert : Info;
            return (
              <li key={item.key} className={cx("flex items-center gap-1.5 text-xs", item.icon === "warn" ? "text-warn" : "text-muted")}>
                <Icon className="size-3.5 shrink-0" aria-hidden /> {item.text}
              </li>
            );
          }
          case "finish": {
            const e = item.event;
            const tone = e.status === "completed" ? "border-ok" : e.status === "failed" ? "border-err" : "border-line-strong";
            return (
              <li key={item.key}>
                <div className={cx("rounded-md border-l-4 bg-panel px-3 py-2.5", tone)}>
                  <p className="text-xs font-semibold">
                    {e.status === "completed" ? "Final answer" : e.status === "failed" ? "Run failed" : "Run cancelled"}
                    <span className="ml-2 font-normal text-muted">{STOP_REASONS[e.stopReason] ?? e.stopReason}</span>
                  </p>
                  {e.output ? (
                    <div className="mt-2">
                      <Markdown text={e.output} />
                    </div>
                  ) : null}
                  {e.error ? <p className="mt-1.5 text-[13px] text-err">{e.error}</p> : null}
                  <p className="tabular mt-2 text-[11px] text-faint">
                    {e.totals.steps} step{e.totals.steps === 1 ? "" : "s"} · {tokens(e.totals.promptTokens)} in → {tokens(e.totals.completionTokens)} out · {usd(e.totals.cost)}
                  </p>
                </div>
              </li>
            );
          }
        }
      })}
      {liveText.map(([key, value]) => {
        const [depth, ...name] = key.split(":");
        return (
          <li key={`live-${key}`}>
            <Row depth={Number(depth)}>
              <p className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-muted">
                <Bot className="size-3" aria-hidden /> {name.join(":")}
              </p>
              {value.reasoning && !value.text ? <p className="caret text-xs whitespace-pre-wrap text-muted">{value.reasoning}</p> : null}
              {value.text ? (
                <div className="caret">
                  <Markdown text={value.text} />
                </div>
              ) : null}
            </Row>
          </li>
        );
      })}
    </ol>
  );
}
