"use client";

import Link from "next/link";
import { Bot, Boxes, FlaskConical, LayoutDashboard, MessageSquare, Wrench, type LucideIcon } from "lucide-react";
import { usd } from "@/lib/shared/format";
import { ConnectKey, useSession } from "./session";
import { Card, Spinner } from "./ui";

const TILES: { href: string; title: string; body: string; icon: LucideIcon }[] = [
  { href: "/models", title: "Explore models", body: "Filter the live catalog by price, context and capability, then compare side by side.", icon: Boxes },
  { href: "/chat", title: "Chat playground", body: "Stream from several models at once with routing, reasoning and structured output.", icon: MessageSquare },
  { href: "/agents", title: "Build agents", body: "Give a model tools, a step limit and a budget, and watch every step live.", icon: Bot },
  { href: "/tools", title: "Tool registry", body: "Built-in tools, your own Zod + JS tools, and MCP servers.", icon: Wrench },
  { href: "/evals", title: "Run evals", body: "Score one prompt or a dataset across models on quality, cost and latency.", icon: FlaskConical },
  { href: "/dashboard", title: "Usage & spend", body: "Credits, spend by model, request logs and retries.", icon: LayoutDashboard },
];

export function Home() {
  const session = useSession();
  return (
    <div className="mx-auto w-full max-w-4xl space-y-8 px-6 py-10">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">OpenRouter Studio</h1>
        <p className="mt-1 text-[13px] text-muted">One workspace for every model on OpenRouter: explore, chat, build agents, evaluate.</p>
      </div>

      {session.loading ? (
        <Spinner />
      ) : session.connected ? (
        <Card className="flex flex-wrap items-center gap-x-8 gap-y-2 px-4 py-3 text-[13px]">
          <span className="flex items-center gap-2">
            <span className="size-1.5 rounded-full bg-ok" />
            Connected as <span className="font-mono text-xs text-muted">{session.keyHint}</span>
          </span>
          {session.key ? (
            <>
              <span className="tabular text-muted">Used {usd(session.key.usage)}</span>
              <span className="tabular text-muted">
                {session.key.limitRemaining !== null ? `${usd(session.key.limitRemaining)} remaining on this key` : "No key limit"}
              </span>
            </>
          ) : null}
          <Link href="/settings" className="ml-auto text-xs text-accent-text underline">Manage key</Link>
        </Card>
      ) : (
        <ConnectKey compact />
      )}

      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {TILES.map((t) => (
          <li key={t.href}>
            <Link href={t.href} className="block h-full rounded-lg border border-line bg-panel p-4 transition-colors hover:border-line-strong">
              <t.icon className="size-4 text-accent-text" aria-hidden />
              <p className="mt-2.5 text-[13px] font-semibold">{t.title}</p>
              <p className="mt-1 text-xs leading-relaxed text-muted">{t.body}</p>
            </Link>
          </li>
        ))}
      </ul>
      <p className="text-xs text-faint">
        Press <kbd className="font-mono">⌘K</kbd> to jump anywhere, or <kbd className="font-mono">?</kbd> for all shortcuts.
      </p>
    </div>
  );
}
