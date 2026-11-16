"use client";

import Link from "next/link";
import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { useResource } from "@/lib/client/api";
import { cx, duration, tokens, usd } from "@/lib/shared/format";
import type { KeyInfo } from "../session";
import { Button, Card, Notice, PageHeader, Spinner, Stat } from "../ui";

interface Optional<T> {
  data: T | null;
  unavailable: string | null;
}

interface UsageResponse {
  key: Optional<KeyInfo>;
  credits: Optional<{ totalCredits: number; totalUsage: number; remaining: number }>;
  activity: Optional<{ date: string; model: string; provider: string | null; usage: number; requests: number; promptTokens: number; completionTokens: number }[]>;
  local: {
    windows: { label: string; requests: number; cost: number; promptTokens: number; completionTokens: number; errors: number; retries: number }[];
    byDay: { day: string; cost: number; requests: number }[];
    byModel: { model: string; requests: number; cost: number; promptTokens: number; completionTokens: number; avgLatencyMs: number | null; errors: number }[];
    byKind: { kind: string; requests: number; cost: number }[];
    latency: { p50: number | null; p95: number | null };
  };
  budget: { windows: { period: "daily" | "monthly"; limitUsd: number; spentUsd: number; ratio: number; exceeded: boolean }[]; hardStop: boolean; blocked: boolean };
}

const KIND_LABEL: Record<string, string> = { chat: "Chat (/chat/completions)", responses: "Chat (/responses)", agent: "Agent runs", eval: "Evals" };

const shortDay = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });

/**
 * Daily spend, one series: bars on a zero baseline in a single hue. Each day's whole
 * column is the hover/focus target, so thin or empty bars are still easy to inspect,
 * and the same numbers are available as a table.
 */
function SpendChart({ days }: { days: UsageResponse["local"]["byDay"] }) {
  const [active, setActive] = useState<number | null>(null);
  const max = Math.max(...days.map((d) => d.cost));
  const total = days.reduce((a, d) => a + d.cost, 0);
  // Round the axis top up to a clean value so gridline labels are readable.
  const magnitude = max > 0 ? 10 ** Math.floor(Math.log10(max)) : 1;
  const top = max > 0 ? Math.ceil(max / magnitude) * magnitude : 1;
  const hovered = active !== null ? days[active] : null;

  if (max === 0) return <p className="py-10 text-center text-[13px] text-muted">No spend through this app in the last 30 days.</p>;

  return (
    <figure>
      <div className="flex gap-2">
        <div className="tabular flex h-40 w-12 shrink-0 flex-col justify-between text-right text-[11px] text-faint" aria-hidden>
          <span>{usd(top)}</span>
          <span>{usd(top / 2)}</span>
          <span>$0</span>
        </div>
        <div className="relative h-40 min-w-0 flex-1">
          <div className="pointer-events-none absolute inset-0 flex flex-col justify-between" aria-hidden>
            <span className="border-t border-line" />
            <span className="border-t border-dashed border-line" />
            <span className="border-t border-line-strong" />
          </div>
          <div className="absolute inset-0 flex items-stretch" role="list" aria-label={`Daily spend for the last 30 days, ${usd(total)} in total`} onMouseLeave={() => setActive(null)}>
            {days.map((d, i) => (
              <div
                key={d.day}
                role="listitem"
                tabIndex={0}
                aria-label={`${shortDay(d.day)}: ${usd(d.cost)}, ${d.requests} request${d.requests === 1 ? "" : "s"}`}
                onMouseEnter={() => setActive(i)}
                onFocus={() => setActive(i)}
                onBlur={() => setActive(null)}
                className={cx("flex min-w-0 flex-1 items-end px-px outline-offset-[-2px]", active === i && "bg-hover")}
              >
                <div
                  className={cx("w-full rounded-t-[4px] transition-colors", active === i ? "bg-accent-hover" : "bg-accent")}
                  // A day with any spend gets at least a visible sliver.
                  style={{ height: d.cost > 0 ? `max(2px, ${(d.cost / top) * 100}%)` : 0 }}
                />
              </div>
            ))}
          </div>
          {hovered && active !== null ? (
            <div
              role="status"
              className="tabular pointer-events-none absolute -top-2 z-10 -translate-y-full rounded-md border border-line bg-panel px-2.5 py-1.5 text-xs whitespace-nowrap shadow-pop"
              style={active < days.length / 2 ? { left: `${(active / days.length) * 100}%` } : { right: `${((days.length - 1 - active) / days.length) * 100}%` }}
            >
              <p className="font-medium">{shortDay(hovered.day)}</p>
              <p className="text-muted">
                {usd(hovered.cost)} · {hovered.requests} request{hovered.requests === 1 ? "" : "s"}
              </p>
            </div>
          ) : null}
        </div>
      </div>
      <div className="tabular mt-1 ml-14 flex justify-between text-[11px] text-faint" aria-hidden>
        <span>{shortDay(days[0].day)}</span>
        <span>{shortDay(days[Math.floor(days.length / 2)].day)}</span>
        <span>{shortDay(days[days.length - 1].day)}</span>
      </div>
      <details className="mt-2">
        <summary className="cursor-pointer text-xs text-muted select-none hover:text-fg">View as table</summary>
        <table className="tabular mt-2 w-full max-w-sm text-left text-xs">
          <thead className="text-muted">
            <tr>
              <th className="py-1 font-medium">Day (UTC)</th>
              <th className="py-1 text-right font-medium">Spend</th>
              <th className="py-1 text-right font-medium">Requests</th>
            </tr>
          </thead>
          <tbody>
            {days.filter((d) => d.requests > 0).map((d) => (
              <tr key={d.day} className="border-t border-line">
                <td className="py-1">{d.day}</td>
                <td className="py-1 text-right">{usd(d.cost)}</td>
                <td className="py-1 text-right">{d.requests}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

function BudgetBar({ w }: { w: UsageResponse["budget"]["windows"][number] }) {
  const pct = Math.min(100, w.ratio * 100);
  const state = w.exceeded ? "Over budget" : w.ratio >= 0.8 ? "Close to the limit" : "Within budget";
  return (
    <div>
      <div className="flex items-baseline justify-between text-xs">
        <span className="font-medium">{w.period === "daily" ? "Daily" : "Monthly"} budget</span>
        <span className="tabular text-muted">
          {usd(w.spentUsd)} of {usd(w.limitUsd)} · {state}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={`${w.period} budget used`}
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        className="mt-1.5 h-2 overflow-hidden rounded-full bg-subtle"
      >
        <div className={cx("h-full rounded-full", w.exceeded ? "bg-err" : w.ratio >= 0.8 ? "bg-warn" : "bg-ok")} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function DashboardPage() {
  const { data, loading, error, reload } = useResource<UsageResponse>("/api/usage");
  const [refreshing, setRefreshing] = useState(false);

  if (loading && !data) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (!data) {
    return (
      <div className="p-6">
        <Notice tone="err">{error?.message ?? "Could not load usage."}</Notice>
      </div>
    );
  }

  const { key, credits, activity, local, budget } = data;
  const month = local.windows[2];
  const errorRate = month.requests ? (month.errors / month.requests) * 100 : 0;

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="OpenRouter's numbers for your key and account, next to what this app has spent."
        actions={
          <Button
            icon={<RefreshCw className="size-3.5" />}
            loading={refreshing}
            onClick={async () => {
              setRefreshing(true);
              await reload();
              setRefreshing(false);
            }}
          >
            Refresh
          </Button>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl space-y-6 px-6 py-6">
          <section aria-labelledby="or-heading">
            <h2 id="or-heading" className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">From OpenRouter</h2>
            <Card className="grid grid-cols-2 gap-x-8 gap-y-4 p-4 sm:grid-cols-4">
              {credits.data ? (
                <Stat label="Account credits left" value={usd(credits.data.remaining)} sub={`${usd(credits.data.totalUsage)} used of ${usd(credits.data.totalCredits)}`} />
              ) : (
                <Stat label="Account credits" value="—" sub={credits.unavailable ?? undefined} />
              )}
              {key.data ? (
                <>
                  <Stat
                    label="This key: remaining"
                    value={key.data.limitRemaining !== null ? usd(key.data.limitRemaining) : "No limit"}
                    sub={key.data.limit !== null ? `limit ${usd(key.data.limit)}` : undefined}
                  />
                  <Stat label="This key: used" value={usd(key.data.usage)} sub={`today ${usd(key.data.usageDaily)} · month ${usd(key.data.usageMonthly)}`} />
                  <Stat label="Key expires" value={<span className="text-sm font-medium">{key.data.expiresAt ? new Date(key.data.expiresAt).toLocaleString() : "Never"}</span>} sub={key.data.isFreeTier ? "free tier" : undefined} />
                </>
              ) : (
                <div className="col-span-3 text-[13px] text-err">{key.unavailable}</div>
              )}
            </Card>
          </section>

          {budget.windows.length ? (
            <section aria-labelledby="budget-heading">
              <h2 id="budget-heading" className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">Budgets</h2>
              <Card className="space-y-4 p-4">
                {budget.windows.map((w) => (
                  <BudgetBar key={w.period} w={w} />
                ))}
                <p className="text-xs text-faint">
                  Measured from this app&apos;s request log. {budget.hardStop ? "New model calls are refused once a budget is spent." : "Alerts only; calls are not blocked."}{" "}
                  <Link href="/settings" className="underline">Change budgets</Link>
                </p>
              </Card>
            </section>
          ) : null}

          <section aria-labelledby="app-heading">
            <h2 id="app-heading" className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">Through this app</h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {local.windows.map((w) => (
                <Card key={w.label} className="p-4">
                  <Stat label={w.label} value={usd(w.cost)} sub={`${w.requests} request${w.requests === 1 ? "" : "s"} · ${tokens(w.promptTokens)} in → ${tokens(w.completionTokens)} out`} />
                </Card>
              ))}
            </div>
            <Card className="mt-3 grid grid-cols-2 gap-x-8 gap-y-3 p-4 sm:grid-cols-4">
              <Stat label="Latency p50 (7 days)" value={duration(local.latency.p50)} />
              <Stat label="Latency p95 (7 days)" value={duration(local.latency.p95)} />
              <Stat label="Failed requests (30 days)" value={month.errors} sub={`${errorRate.toFixed(1)}% of requests`} />
              <Stat label="Automatic retries (30 days)" value={month.retries} sub="after 429 / 5xx / timeouts" />
            </Card>
          </section>

          <section aria-labelledby="spend-heading">
            <h2 id="spend-heading" className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">Daily spend, last 30 days (UTC)</h2>
            <Card className="p-4 pt-8">
              <SpendChart days={local.byDay} />
            </Card>
          </section>

          <section aria-labelledby="model-heading" className="grid grid-cols-1 gap-3 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <h2 id="model-heading" className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">By model (30 days)</h2>
              <Card className="overflow-x-auto">
                {local.byModel.length === 0 ? (
                  <p className="p-6 text-center text-[13px] text-muted">No requests yet.</p>
                ) : (
                  <table className="tabular w-full text-left text-xs">
                    <thead className="text-muted">
                      <tr>
                        {["Model", "Requests", "Spend", "Tokens in → out", "Avg latency", "Failed"].map((h, i) => (
                          <th key={h} className={cx("px-3 py-2 font-medium whitespace-nowrap", i > 0 && "text-right")}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {local.byModel.map((m) => (
                        <tr key={m.model} className="border-t border-line">
                          <td className="max-w-56 truncate px-3 py-2 font-mono">{m.model}</td>
                          <td className="px-3 py-2 text-right">{m.requests}</td>
                          <td className="px-3 py-2 text-right">{usd(m.cost)}</td>
                          <td className="px-3 py-2 text-right whitespace-nowrap">{tokens(m.promptTokens)} → {tokens(m.completionTokens)}</td>
                          <td className="px-3 py-2 text-right">{duration(m.avgLatencyMs)}</td>
                          <td className={cx("px-3 py-2 text-right", m.errors > 0 && "text-err")}>{m.errors}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>
            </div>
            <div>
              <h2 className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">By feature (30 days)</h2>
              <Card className="p-4">
                {local.byKind.length === 0 ? (
                  <p className="text-[13px] text-muted">No requests yet.</p>
                ) : (
                  <ul className="space-y-2.5">
                    {local.byKind.map((k) => (
                      <li key={k.kind} className="flex items-baseline justify-between gap-3 text-[13px]">
                        <span>{KIND_LABEL[k.kind] ?? k.kind}</span>
                        <span className="tabular text-muted">
                          {usd(k.cost)} · {k.requests}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                <Link href="/logs" className="mt-4 inline-block text-xs text-accent-text underline">Open the request log</Link>
              </Card>
            </div>
          </section>

          <section aria-labelledby="activity-heading">
            <h2 id="activity-heading" className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">Account activity from OpenRouter (30 days)</h2>
            {activity.data ? (
              <Card className="overflow-x-auto">
                <table className="tabular w-full text-left text-xs">
                  <thead className="text-muted">
                    <tr>
                      {["Date", "Model", "Provider", "Requests", "Spend"].map((h, i) => (
                        <th key={h} className={cx("px-3 py-2 font-medium", i > 2 && "text-right")}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {activity.data.slice(0, 40).map((r, i) => (
                      <tr key={i} className="border-t border-line">
                        <td className="px-3 py-2">{r.date}</td>
                        <td className="px-3 py-2 font-mono">{r.model}</td>
                        <td className="px-3 py-2 text-muted">{r.provider ?? "—"}</td>
                        <td className="px-3 py-2 text-right">{r.requests}</td>
                        <td className="px-3 py-2 text-right">{usd(r.usage)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            ) : (
              <Notice>
                Account-wide activity is only available to management keys. ({activity.unavailable}) Everything above still works with a regular key.
              </Notice>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
