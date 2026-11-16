"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, History, Pause, Play, RotateCcw, Square, Trash2, X } from "lucide-react";
import { api, ApiClientError } from "@/lib/client/api";
import { useNow } from "@/lib/client/use-now";
import { useRun } from "@/lib/client/use-run";
import { cx, dateTime, duration, tokens, usd } from "@/lib/shared/format";
import { isTerminal, type RunEvent, type RunStatus } from "@/lib/shared/runs";
import { Badge, Button, EmptyState, Notice, Select, Spinner, Stat } from "../ui";
import { buildTimeline, Trace } from "./trace";

const STATUS_TONE: Record<RunStatus, "accent" | "warn" | "ok" | "err" | "neutral"> = {
  running: "accent",
  paused: "warn",
  awaiting_approval: "warn",
  completed: "ok",
  failed: "err",
  cancelled: "neutral",
};

export function StatusBadge({ status }: { status: RunStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{status.replace("_", " ")}</Badge>;
}

/**
 * Replays a stored trace with its original pacing. Long silences are shortened so a
 * replay stays watchable; the scrubber jumps anywhere.
 */
function useReplay(events: RunEvent[]) {
  const [active, setActive] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [speed, setSpeed] = useState(4);

  useEffect(() => {
    if (!active || !playing) return;
    if (position >= events.length) return;
    const gap = position === 0 ? 0 : events[position].ts - events[position - 1].ts;
    const timer = setTimeout(() => setPosition((p) => Math.min(p + 1, events.length)), Math.min(gap, 2500) / speed);
    return () => clearTimeout(timer);
  }, [active, playing, position, speed, events]);

  const atEnd = position >= events.length;
  return {
    active,
    playing: playing && !atEnd,
    position,
    speed,
    setSpeed,
    visible: active ? events.slice(0, position) : events,
    start: () => {
      setActive(true);
      setPosition(0);
      setPlaying(true);
    },
    stop: () => {
      setActive(false);
      setPlaying(false);
    },
    toggle: () => {
      if (atEnd) setPosition(0);
      setPlaying((p) => (atEnd ? true : !p));
    },
    seek: (to: number) => {
      setPosition(to);
      setPlaying(false);
    },
  };
}

export function RunView({ runId }: { runId: string }) {
  const router = useRouter();
  const { run, events, streaming, error, loading, reload } = useRun(runId);
  const replay = useReplay(events);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  const { pendingApprovals } = useMemo(() => buildTimeline(events), [events]);
  const live = run !== null && !isTerminal(run.status);
  const now = useNow(1000, live);

  // Follow the trace while it grows, unless the reader has scrolled up.
  const streamedChars = Object.values(streaming).reduce((n, v) => n + v.text.length + v.reasoning.length, 0);
  useEffect(() => {
    if (pinned.current && (live || replay.playing)) bottom.current?.scrollIntoView({ block: "end" });
  }, [events.length, streamedChars, replay.position, live, replay.playing]);

  async function control(action: string, body: Record<string, unknown> = {}) {
    setBusy(action);
    setActionError(null);
    try {
      return await api.post<{ ok?: boolean; id?: string }>(`/api/runs/${runId}/control`, { action, ...body });
    } catch (err) {
      setActionError(err instanceof ApiClientError ? err.message : "That did not work. Try again.");
      return null;
    } finally {
      setBusy(null);
    }
  }

  const decide = (ids: string[], approve: boolean) => control("approve", approve ? { approve: ids } : { reject: ids });

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (error || !run) {
    return (
      <EmptyState title="This run could not be loaded" action={<Link href="/runs" className="text-accent-text underline">Back to runs</Link>}>
        {error ?? "It may have been deleted."}
      </EmptyState>
    );
  }

  const elapsed = run.startedAt ? (run.endedAt ?? now) - run.startedAt : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="border-b border-line px-6 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/runs" aria-label="Back to runs" className="rounded-md p-1 text-muted hover:bg-hover hover:text-fg">
            <ArrowLeft className="size-4" />
          </Link>
          <h1 className="text-base font-semibold tracking-tight">{run.agentName}</h1>
          <StatusBadge status={run.status} />
          {run.replayOf ? (
            <Link href={`/runs?id=${run.replayOf}`} className="text-xs text-accent-text underline">
              re-run of an earlier run
            </Link>
          ) : null}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {run.status === "running" ? (
              <Button icon={<Pause className="size-3.5" />} loading={busy === "pause"} onClick={() => void control("pause")}>
                Pause
              </Button>
            ) : null}
            {run.status === "paused" ? (
              <Button variant="primary" icon={<Play className="size-3.5" />} loading={busy === "resume"} onClick={() => void control("resume")}>
                Resume
              </Button>
            ) : null}
            {live ? (
              <Button variant="danger" icon={<Square className="size-3.5" />} loading={busy === "cancel"} onClick={() => void control("cancel").then(reload)}>
                Cancel
              </Button>
            ) : (
              <>
                <Button icon={<History className="size-3.5" />} onClick={replay.active ? replay.stop : replay.start} aria-pressed={replay.active}>
                  {replay.active ? "Exit replay" : "Replay trace"}
                </Button>
                <Button
                  icon={<RotateCcw className="size-3.5" />}
                  loading={busy === "rerun"}
                  onClick={async () => {
                    const res = await control("rerun");
                    if (res?.id) router.push(`/runs?id=${res.id}`);
                  }}
                >
                  Run again
                </Button>
                <Button
                  variant="ghost"
                  aria-label="Delete run"
                  icon={<Trash2 className="size-3.5" />}
                  onClick={async () => {
                    if (!window.confirm("Delete this run and its trace?")) return;
                    await api.del(`/api/runs/${runId}`);
                    router.push("/runs");
                  }}
                />
              </>
            )}
          </div>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-x-8 gap-y-2 sm:grid-cols-5">
          <Stat label="Steps" value={run.steps} />
          <Stat label="Tokens" value={`${tokens(run.promptTokens)} → ${tokens(run.completionTokens)}`} />
          <Stat label="Cost" value={usd(run.cost)} />
          <Stat label="Duration" value={elapsed !== null ? duration(elapsed) : "—"} />
          <Stat label="Started" value={<span className="text-sm font-medium">{dateTime(run.createdAt)}</span>} />
        </div>
        {actionError ? <Notice tone="err" className="mt-3">{actionError}</Notice> : null}
      </header>

      {replay.active ? (
        <div className="flex flex-wrap items-center gap-3 border-b border-line bg-subtle px-6 py-2">
          <Button size="sm" icon={replay.playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />} onClick={replay.toggle}>
            {replay.playing ? "Pause" : replay.position >= events.length ? "Replay" : "Play"}
          </Button>
          <input
            type="range"
            aria-label="Replay position"
            min={0}
            max={events.length}
            value={replay.position}
            onChange={(e) => replay.seek(Number(e.target.value))}
            className="min-w-40 flex-1 accent-[var(--accent)]"
          />
          <span className="tabular text-xs text-muted">
            event {replay.position} of {events.length}
          </span>
          <Select aria-label="Replay speed" value={replay.speed} onChange={(e) => replay.setSpeed(Number(e.target.value))} className="w-20">
            <option value={1}>1×</option>
            <option value={4}>4×</option>
            <option value={16}>16×</option>
          </Select>
        </div>
      ) : null}

      <div
        className="min-h-0 flex-1 overflow-y-auto px-6 py-5"
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        <div className="mx-auto max-w-3xl">
          <Trace
            events={replay.visible}
            streaming={replay.active ? {} : streaming}
            live={live && !replay.active}
            deciding={busy === "approve"}
            onDecide={live ? (callId, approve) => void decide([callId], approve) : undefined}
          />
          {live && run.status === "running" && Object.keys(streaming).length === 0 ? (
            <p className="mt-4 flex items-center gap-2 text-xs text-faint">
              <Spinner className="size-3" /> Working…
            </p>
          ) : null}
          {run.status === "failed" && !events.some((e) => e.type === "run.finished") ? <Notice tone="err" className="mt-4">{run.error}</Notice> : null}
          <div ref={bottom} />
        </div>
      </div>

      {live && pendingApprovals.length > 0 ? (
        <div role="alert" className={cx("flex flex-wrap items-center gap-3 border-t border-warn bg-warn-soft px-6 py-2.5 text-[13px] text-warn")}>
          <span className="font-medium">
            {pendingApprovals.length} tool call{pendingApprovals.length === 1 ? "" : "s"} waiting for your approval
          </span>
          <span className="text-xs opacity-80">Review the arguments above, then decide.</span>
          <div className="ml-auto flex gap-2">
            <Button size="sm" variant="primary" icon={<Check className="size-3.5" />} loading={busy === "approve"} onClick={() => void decide(pendingApprovals, true)}>
              Approve all
            </Button>
            <Button size="sm" variant="danger" icon={<X className="size-3.5" />} disabled={busy === "approve"} onClick={() => void decide(pendingApprovals, false)}>
              Reject all
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
