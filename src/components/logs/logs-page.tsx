"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/client/api";
import { cx, dateTime, duration, tokens, usd } from "@/lib/shared/format";
import { Badge, Button, Dialog, EmptyState, Input, Notice, PageHeader, Select, Spinner } from "../ui";

interface LogRow {
  id: string;
  ts: number;
  kind: string;
  endpoint: string;
  method: string;
  model: string | null;
  modelUsed: string | null;
  provider: string | null;
  status: number | null;
  ok: boolean;
  streamed: boolean;
  latencyMs: number | null;
  ttftMs: number | null;
  retries: number;
  promptTokens: number | null;
  completionTokens: number | null;
  reasoningTokens: number | null;
  cachedTokens: number | null;
  cost: number | null;
  generationId: string | null;
  finishReason: string | null;
  error: string | null;
  refType: string | null;
  refId: string | null;
}

interface Filters {
  kind: string;
  status: string;
  model: string;
}

function query(filters: Filters, before?: number): string {
  const params = new URLSearchParams({ limit: "100" });
  if (filters.kind) params.set("kind", filters.kind);
  if (filters.status) params.set("status", filters.status);
  if (filters.model.trim()) params.set("model", filters.model.trim());
  if (before) params.set("before", String(before));
  return `/api/logs?${params}`;
}

export function LogsPage() {
  const [filters, setFilters] = useState<Filters>({ kind: "", status: "", model: "" });
  const [rows, setRows] = useState<LogRow[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "more" | "error">("loading");
  const [open, setOpen] = useState<LogRow | null>(null);

  useEffect(() => {
    let stale = false;
    // Debounced so typing in the model filter does not fire a request per keystroke.
    const timer = setTimeout(() => {
      api.get<{ logs: LogRow[]; nextBefore: number | null }>(query(filters)).then(
        (res) => {
          if (stale) return;
          setRows(res.logs);
          setNext(res.nextBefore);
          setState("ready");
        },
        () => !stale && setState("error"),
      );
    }, 200);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [filters]);

  async function loadMore() {
    if (!next) return;
    setState("more");
    const res = await api.get<{ logs: LogRow[]; nextBefore: number | null }>(query(filters, next));
    setRows((cur) => [...cur, ...res.logs]);
    setNext(res.nextBefore);
    setState("ready");
  }

  const change = (patch: Partial<Filters>) => {
    setState("loading");
    setFilters((f) => ({ ...f, ...patch }));
  };

  return (
    <>
      <PageHeader title="Logs" description="One row per upstream OpenRouter request made through this app, including failures and retries." />
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-6 py-3">
        <Select aria-label="Feature" value={filters.kind} onChange={(e) => change({ kind: e.target.value })} className="w-44">
          <option value="">All model calls</option>
          <option value="chat">Chat (/chat/completions)</option>
          <option value="responses">Chat (/responses)</option>
          <option value="agent">Agent runs</option>
          <option value="eval">Evals</option>
          <option value="meta">Catalog &amp; key lookups</option>
        </Select>
        <Select aria-label="Outcome" value={filters.status} onChange={(e) => change({ status: e.target.value })} className="w-36">
          <option value="">Any outcome</option>
          <option value="ok">Succeeded</option>
          <option value="error">Failed</option>
          <option value="retried">Retried</option>
        </Select>
        <Input data-page-search type="search" aria-label="Filter by model" placeholder="Filter by model…  ( / )" value={filters.model} onChange={(e) => change({ model: e.target.value })} className="w-64" />
      </div>

      {state === "error" ? (
        <div className="p-6">
          <Notice tone="err">Could not load the log.</Notice>
        </div>
      ) : state === "loading" ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState title="No matching requests">Requests appear here as soon as you chat, run an agent or run an eval.</EmptyState>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="tabular w-full text-left text-xs">
            <thead className="sticky top-0 bg-bg text-muted shadow-[0_1px_0_var(--line)]">
              <tr>
                {["Time", "Feature", "Model", "Status", "Latency", "Tokens in → out", "Cost", "Retries"].map((h, i) => (
                  <th key={h} className={cx("px-2.5 py-2 font-medium whitespace-nowrap", i === 0 && "pl-6", i >= 4 && "text-right", i === 7 && "pr-6")}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  tabIndex={0}
                  onClick={() => setOpen(r)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      // Without this the same keypress would land on the dialog's close button.
                      e.preventDefault();
                      setOpen(r);
                    }
                    if (e.key === "ArrowDown") (e.currentTarget.nextElementSibling as HTMLElement | null)?.focus();
                    if (e.key === "ArrowUp") (e.currentTarget.previousElementSibling as HTMLElement | null)?.focus();
                  }}
                  className="cursor-pointer border-b border-line outline-offset-[-2px] hover:bg-subtle"
                >
                  <td className="py-1.5 pr-2.5 pl-6 whitespace-nowrap text-muted">{dateTime(r.ts)}</td>
                  <td className="px-2.5 py-1.5">{r.kind}</td>
                  <td className="max-w-64 truncate px-2.5 py-1.5 font-mono">{r.modelUsed ?? r.model ?? r.endpoint}</td>
                  <td className="px-2.5 py-1.5">
                    <Badge tone={r.ok ? "ok" : "err"}>{r.ok ? (r.status ?? "ok") : r.error === "aborted" ? "stopped" : (r.status ?? "failed")}</Badge>
                  </td>
                  <td className="px-2.5 py-1.5 text-right">{duration(r.latencyMs)}</td>
                  <td className="px-2.5 py-1.5 text-right whitespace-nowrap">{r.promptTokens !== null ? `${tokens(r.promptTokens)} → ${tokens(r.completionTokens)}` : "—"}</td>
                  <td className="px-2.5 py-1.5 text-right">{usd(r.cost)}</td>
                  <td className={cx("py-1.5 pr-6 pl-2.5 text-right", r.retries > 0 && "font-medium text-warn")}>{r.retries}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {next ? (
            <div className="flex justify-center py-4">
              <Button loading={state === "more"} onClick={() => void loadMore()}>Load older requests</Button>
            </div>
          ) : null}
        </div>
      )}

      <Dialog open={open !== null} onClose={() => setOpen(null)} wide title={open ? `${open.method} ${open.endpoint}` : ""}>
        {open ? (
          <div className="space-y-4">
            {open.error ? <Notice tone="err">{open.error === "aborted" ? "Stopped before it finished (cancelled by the user or a dropped connection)." : open.error}</Notice> : null}
            <dl className="tabular grid grid-cols-2 gap-x-6 gap-y-3 text-[13px] sm:grid-cols-3">
              {(
                [
                  ["Time", dateTime(open.ts)],
                  ["Feature", open.kind],
                  ["HTTP status", open.status ?? "no response"],
                  ["Requested model", open.model ?? "—"],
                  ["Answered by", open.modelUsed ?? "—"],
                  ["Provider", open.provider ?? "—"],
                  ["Latency", duration(open.latencyMs)],
                  ["First token", duration(open.ttftMs)],
                  ["Retries", open.retries],
                  ["Input tokens", open.promptTokens ?? "—"],
                  ["Output tokens", open.completionTokens ?? "—"],
                  ["Reasoning tokens", open.reasoningTokens ?? "—"],
                  ["Cached tokens", open.cachedTokens ?? "—"],
                  ["Cost", usd(open.cost)],
                  ["Finish reason", open.finishReason ?? "—"],
                ] as const
              ).map(([k, v]) => (
                <div key={k} className="min-w-0">
                  <dt className="text-xs text-muted">{k}</dt>
                  <dd className="truncate font-medium">{v}</dd>
                </div>
              ))}
            </dl>
            {open.generationId ? (
              <p className="text-xs text-muted">
                Generation id: <span className="font-mono">{open.generationId}</span>
              </p>
            ) : null}
            {open.refType === "run" && open.refId ? (
              <Link href={`/runs?id=${open.refId}`} className="text-xs text-accent-text underline">Open the agent run this belongs to</Link>
            ) : null}
            {open.refType === "eval" && open.refId ? (
              <Link href={`/evals?id=${open.refId}`} className="text-xs text-accent-text underline">Open the eval this belongs to</Link>
            ) : null}
          </div>
        ) : null}
      </Dialog>
    </>
  );
}
