"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isTerminal, type RunEvent, type RunSummary } from "@/lib/shared/runs";
import { api, ApiClientError } from "./api";
import { readSse } from "./sse";

export interface RunView {
  run: RunSummary | null;
  /** Stored events, in order. */
  events: RunEvent[];
  /** Text still being streamed, keyed by `${depth}:${agent}`. Cleared when the full message arrives. */
  streaming: Record<string, { text: string; reasoning: string }>;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

const key = (e: { depth: number; agent: string }) => `${e.depth}:${e.agent}`;

/**
 * Loads a run's stored trace, then follows it live. If the stream drops while the run is
 * still going, it reconnects from the last event it saw, so nothing is missed or doubled.
 */
export function useRun(runId: string | null): RunView {
  const [run, setRun] = useState<RunSummary | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [streaming, setStreaming] = useState<RunView["streaming"]>({});
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const lastSeq = useRef(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!runId) return;
    const abort = new AbortController();
    let stopped = false;
    lastSeq.current = 0;

    const apply = (event: RunEvent) => {
      if (event.type === "delta") {
        setStreaming((cur) => {
          const prev = cur[key(event)] ?? { text: "", reasoning: "" };
          return { ...cur, [key(event)]: event.kind === "text" ? { ...prev, text: prev.text + event.text } : { ...prev, reasoning: prev.reasoning + event.text } };
        });
        return;
      }
      if (event.seq <= lastSeq.current) return;
      lastSeq.current = event.seq;
      setEvents((cur) => [...cur, event]);
      if (event.type === "message" || event.type === "step.finished") {
        // The complete text is now in the log; drop the live buffer for that agent.
        setStreaming((cur) => {
          if (!(key(event) in cur)) return cur;
          const next = { ...cur };
          delete next[key(event)];
          return next;
        });
      }
    };

    const refreshSummary = () =>
      api.get<{ run: RunSummary }>(`/api/runs/${runId}`, abort.signal).then(
        (res) => !stopped && setRun(res.run),
        () => {},
      );

    (async () => {
      try {
        const initial = await api.get<{ run: RunSummary; events: RunEvent[]; live: boolean }>(`/api/runs/${runId}`, abort.signal);
        if (stopped) return;
        setRun(initial.run);
        setEvents(initial.events);
        setStreaming({});
        setError(null);
        setLoaded(runId);
        lastSeq.current = initial.events.at(-1)?.seq ?? 0;
        if (!initial.live) return;

        while (!stopped) {
          let finished = false;
          try {
            const res = await fetch(`/api/runs/${runId}/events?after=${lastSeq.current}`, { signal: abort.signal, headers: { Accept: "text/event-stream" } });
            await readSse<RunEvent>(res, (event) => {
              apply(event);
              // Status changes are worth reflecting in the header right away.
              if (["run.paused", "run.resumed", "approval.requested", "approval.resolved", "step.finished", "run.finished"].includes(event.type)) void refreshSummary();
              if (event.type === "run.finished") finished = true;
            });
          } catch (err) {
            if (stopped) return;
            // A 404/401 will not fix itself; a dropped connection will.
            if (err instanceof ApiClientError && err.status >= 400 && err.status < 500) throw err;
          }
          if (finished || stopped) break;
          // The stream ended without a finish event: check whether the run is over, else reconnect.
          const check = await api.get<{ run: RunSummary; live: boolean }>(`/api/runs/${runId}`, abort.signal).catch(() => null);
          if (check) setRun(check.run);
          if (check && (!check.live || isTerminal(check.run.status))) break;
          await new Promise((r) => setTimeout(r, 1000));
        }
        await refreshSummary();
      } catch (err) {
        if (!stopped) {
          setError(err instanceof ApiClientError ? err.message : "Could not load this run.");
          setLoaded(runId);
        }
      }
    })();

    return () => {
      stopped = true;
      abort.abort();
    };
  }, [runId, nonce]);

  const current = loaded === runId;
  return {
    run: current ? run : null,
    events: current ? events : [],
    streaming: current ? streaming : {},
    error: current ? error : null,
    loading: runId !== null && !current,
    reload,
  };
}
