"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import { useResource } from "@/lib/client/api";
import { cx, usd } from "@/lib/shared/format";
import { useSession } from "./session";

interface BudgetWindow {
  period: "daily" | "monthly";
  limitUsd: number;
  spentUsd: number;
  ratio: number;
  crossed: number | null;
  exceeded: boolean;
}

interface BudgetStatus {
  windows: BudgetWindow[];
  hardStop: boolean;
  blocked: boolean;
}

/**
 * App-wide banner that appears when spend crosses a configured budget threshold.
 * Dismissing hides that threshold only; crossing the next one raises it again.
 */
export function BudgetAlerts() {
  const { connected } = useSession();
  const { data } = useResource<BudgetStatus>(connected ? "/api/budget" : null, { pollMs: 30_000 });
  const [dismissed, setDismissed] = useState<string[]>([]);

  useEffect(() => {
    try {
      setDismissed(JSON.parse(sessionStorage.getItem("ors-dismissed-alerts") ?? "[]"));
    } catch {
      /* ignore unreadable storage */
    }
  }, []);

  const active = (data?.windows ?? []).filter((w) => w.crossed !== null);
  const visible = active.filter((w) => !dismissed.includes(`${w.period}:${w.crossed}`) || (w.exceeded && data?.hardStop));
  if (visible.length === 0) return null;

  function dismiss(w: BudgetWindow) {
    const next = [...dismissed, `${w.period}:${w.crossed}`];
    setDismissed(next);
    try {
      sessionStorage.setItem("ors-dismissed-alerts", JSON.stringify(next));
    } catch {
      /* ignore */
    }
  }

  return (
    <div role="alert" className="border-b border-line">
      {visible.map((w) => {
        const blocked = w.exceeded && data?.hardStop;
        return (
          <div
            key={w.period}
            className={cx("flex items-center gap-2 px-4 py-1.5 text-xs", w.exceeded ? "bg-err-soft text-err" : "bg-warn-soft text-warn")}
          >
            <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1">
              {w.exceeded ? "Over" : `${Math.round(w.ratio * 100)}% of`} your {w.period} budget: {usd(w.spentUsd)} of {usd(w.limitUsd)} spent.
              {blocked ? " New model calls are blocked." : ""}{" "}
              <Link href="/settings" className="underline">
                Adjust budget
              </Link>
            </span>
            {!blocked ? (
              <button type="button" aria-label="Dismiss alert" onClick={() => dismiss(w)} className="rounded p-0.5 hover:bg-black/10">
                <X className="size-3.5" />
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
