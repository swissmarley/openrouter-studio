"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useResource } from "@/lib/client/api";
import { useNow } from "@/lib/client/use-now";
import { duration, timeAgo, usd } from "@/lib/shared/format";
import { isTerminal, type RunSummary } from "@/lib/shared/runs";
import { EmptyState, Notice, PageHeader, Spinner } from "../ui";
import { RunView, StatusBadge } from "./run-view";

function RunsList() {
  const router = useRouter();
  const { data, loading, error } = useResource<{ runs: RunSummary[] }>("/api/runs?limit=100", { pollMs: 4000 });
  const runs = data?.runs ?? [];
  const now = useNow(1000, runs.some((r) => !isTerminal(r.status)));

  return (
    <>
      <PageHeader title="Runs" description="Every agent run is saved with its full trace. Open one to follow it live, replay it, or run it again." />
      {error ? (
        <div className="p-6">
          <Notice tone="err">{error.message}</Notice>
        </div>
      ) : loading ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner />
        </div>
      ) : runs.length === 0 ? (
        <EmptyState title="No runs yet" action={<Link href="/agents" className="text-accent-text underline">Go to agents</Link>}>
          Start a run from an agent and it will appear here.
        </EmptyState>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full text-left text-[13px]">
            <thead className="sticky top-0 bg-bg text-xs text-muted shadow-[0_1px_0_var(--line)]">
              <tr>
                <th className="py-2 pr-2 pl-6 font-medium">Status</th>
                <th className="px-2 py-2 font-medium">Agent</th>
                <th className="px-2 py-2 font-medium">Task</th>
                <th className="px-2 py-2 text-right font-medium">Steps</th>
                <th className="px-2 py-2 text-right font-medium">Cost</th>
                <th className="px-2 py-2 text-right font-medium">Duration</th>
                <th className="py-2 pr-6 pl-2 text-right font-medium">Started</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr
                  key={r.id}
                  tabIndex={0}
                  onClick={() => router.push(`/runs?id=${r.id}`)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") router.push(`/runs?id=${r.id}`);
                    if (e.key === "ArrowDown") (e.currentTarget.nextElementSibling as HTMLElement | null)?.focus();
                    if (e.key === "ArrowUp") (e.currentTarget.previousElementSibling as HTMLElement | null)?.focus();
                  }}
                  className="cursor-pointer border-b border-line outline-offset-[-2px] hover:bg-subtle"
                >
                  <td className="py-2 pr-2 pl-6"><StatusBadge status={r.status} /></td>
                  <td className="px-2 py-2 font-medium whitespace-nowrap">{r.agentName}</td>
                  <td className="max-w-md truncate px-2 py-2 text-muted">{r.input}</td>
                  <td className="tabular px-2 py-2 text-right">{r.steps}</td>
                  <td className="tabular px-2 py-2 text-right">{usd(r.cost)}</td>
                  <td className="tabular px-2 py-2 text-right">
                    {r.startedAt ? duration((isTerminal(r.status) ? (r.endedAt ?? r.startedAt) : now) - r.startedAt) : "—"}
                  </td>
                  <td className="py-2 pr-6 pl-2 text-right whitespace-nowrap text-muted">{timeAgo(r.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export function RunsPage() {
  const id = useSearchParams().get("id");
  // Keyed so switching runs resets replay state and scroll position.
  return id ? <RunView key={id} runId={id} /> : <RunsList />;
}
