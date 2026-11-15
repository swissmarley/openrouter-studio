"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  Activity,
  Bot,
  Boxes,
  FlaskConical,
  History,
  LayoutDashboard,
  Menu,
  MessageSquare,
  Moon,
  ScrollText,
  Search,
  Settings,
  Sun,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { cx, usd } from "@/lib/shared/format";
import { BudgetAlerts } from "./budget-alerts";
import { SessionProvider, useSession } from "./session";
import { Dialog, Kbd } from "./ui";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Second key of the `g` chord that jumps here. */
  key: string;
}

const NAV: NavItem[] = [
  { href: "/models", label: "Models", icon: Boxes, key: "m" },
  { href: "/chat", label: "Chat", icon: MessageSquare, key: "c" },
  { href: "/agents", label: "Agents", icon: Bot, key: "a" },
  { href: "/runs", label: "Runs", icon: History, key: "r" },
  { href: "/tools", label: "Tools", icon: Wrench, key: "t" },
  { href: "/evals", label: "Evals", icon: FlaskConical, key: "e" },
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, key: "d" },
  { href: "/logs", label: "Logs", icon: ScrollText, key: "l" },
  { href: "/settings", label: "Settings", icon: Settings, key: "s" },
];

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable;
}

type Theme = "light" | "dark";

// The theme lives on <html data-theme> (set before paint by the inline script in the
// layout), so React reads it as an external store instead of mirroring it in state.
const themeListeners = new Set<() => void>();
const readTheme = (): Theme => (document.documentElement.dataset.theme === "dark" ? "dark" : "light");
const subscribeTheme = (fn: () => void) => {
  themeListeners.add(fn);
  return () => {
    themeListeners.delete(fn);
  };
};

function useTheme() {
  const theme = useSyncExternalStore<Theme>(subscribeTheme, readTheme, () => "light");
  const toggle = useCallback(() => {
    const next: Theme = readTheme() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("ors-theme", next);
    } catch {
      /* storage unavailable: the choice just won't persist */
    }
    themeListeners.forEach((fn) => fn());
  }, []);
  return { theme, toggle };
}

interface Command {
  id: string;
  label: string;
  hint?: string;
  icon: LucideIcon;
  run: () => void;
}

function CommandPalette({ open, onClose, commands }: { open: boolean; onClose: () => void; commands: Command[] }) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? commands.filter((c) => c.label.toLowerCase().includes(q)) : commands;
  }, [commands, query]);

  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    if (open && !el.open) {
      el.showModal();
      inputRef.current?.focus();
    }
    if (!open && el.open) el.close();
  }, [open]);

  // Reset for next time as the palette closes, not when it reopens.
  function close() {
    setQuery("");
    setIndex(0);
    onClose();
  }

  function run(cmd: Command | undefined) {
    if (!cmd) return;
    close();
    cmd.run();
  }

  return (
    <dialog
      ref={dialogRef}
      aria-label="Command palette"
      onClose={close}
      onClick={(e) => e.target === dialogRef.current && close()}
      className="mx-auto mt-[14vh] mb-auto w-[calc(100vw-2rem)] max-w-lg rounded-xl border border-line bg-panel p-0 text-fg shadow-pop"
    >
      <div className="flex items-center gap-2 border-b border-line px-3">
        <Search className="size-4 text-faint" aria-hidden />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setIndex((i) => Math.min(i + 1, matches.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIndex((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              run(matches[index]);
            }
          }}
          placeholder="Jump to a page or run a command…"
          aria-label="Search commands"
          role="combobox"
          aria-expanded="true"
          aria-controls="command-list"
          aria-activedescendant={matches[index] ? `cmd-${matches[index].id}` : undefined}
          className="h-11 flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
        />
        <Kbd>esc</Kbd>
      </div>
      <ul id="command-list" role="listbox" className="max-h-72 overflow-y-auto p-1.5">
        {matches.length === 0 ? <li className="px-3 py-6 text-center text-[13px] text-muted">No matching commands.</li> : null}
        {matches.map((cmd, i) => (
          <li
            key={cmd.id}
            id={`cmd-${cmd.id}`}
            role="option"
            aria-selected={i === index}
            onMouseEnter={() => setIndex(i)}
            onClick={() => run(cmd)}
            className={cx(
              "flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px]",
              i === index ? "bg-hover" : "",
            )}
          >
            <cmd.icon className="size-4 text-muted" aria-hidden />
            <span className="flex-1">{cmd.label}</span>
            {cmd.hint ? <span className="flex gap-1">{cmd.hint.split(" ").map((k) => <Kbd key={k}>{k}</Kbd>)}</span> : null}
          </li>
        ))}
      </ul>
    </dialog>
  );
}

function ShortcutHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  const rows: [string, string][] = [
    ["⌘ K", "Open the command palette"],
    ["/", "Focus search on the current page"],
    ["?", "Show this help"],
    ["esc", "Close a dialog, or stop a running generation"],
    ["⌘ ↵", "Send a message / run"],
    ...NAV.map((n): [string, string] => [`g ${n.key}`, `Go to ${n.label}`]),
  ];
  return (
    <Dialog open={open} onClose={onClose} title="Keyboard shortcuts">
      <ul className="grid grid-cols-1 gap-x-8 gap-y-2 sm:grid-cols-2">
        {rows.map(([keys, label]) => (
          <li key={keys} className="flex items-center justify-between gap-3 text-[13px]">
            <span className="text-muted">{label}</span>
            <span className="flex gap-1">{keys.split(" ").map((k) => <Kbd key={k}>{k}</Kbd>)}</span>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

function KeyStatus() {
  const session = useSession();
  if (session.loading) return <div className="h-9" />;
  if (!session.connected) {
    return (
      <Link href="/settings" className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-warn hover:bg-hover">
        <span className="size-1.5 rounded-full bg-warn" />
        No key connected
      </Link>
    );
  }
  const key = session.key;
  return (
    <Link href="/settings" className="block rounded-md px-2 py-1.5 hover:bg-hover" title="Manage key">
      <span className="flex items-center gap-2 text-xs">
        <span className={cx("size-1.5 rounded-full", session.keyError ? "bg-err" : "bg-ok")} />
        <span className="truncate font-mono text-[11px] text-muted">{session.keyHint}</span>
      </span>
      {key ? (
        <span className="tabular mt-0.5 block pl-3.5 text-[11px] text-faint">
          {key.limitRemaining !== null ? `${usd(key.limitRemaining)} left of ${usd(key.limit)}` : `${usd(key.usage)} used`}
        </span>
      ) : null}
    </Link>
  );
}

function ShellInner({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { theme, toggle } = useTheme();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const chord = useRef<number>(0);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      // Leave keys alone while a modal dialog has focus.
      if (document.querySelector("dialog[open]")) return;

      if (Date.now() - chord.current < 1200) {
        chord.current = 0;
        const target = NAV.find((n) => n.key === e.key.toLowerCase());
        if (target) {
          e.preventDefault();
          router.push(target.href);
        }
        return;
      }
      if (e.key === "g") {
        chord.current = Date.now();
      } else if (e.key === "?") {
        e.preventDefault();
        setHelpOpen(true);
      } else if (e.key === "/") {
        const search = document.querySelector<HTMLElement>("[data-page-search]");
        if (search) {
          e.preventDefault();
          search.focus();
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);

  const commands = useMemo<Command[]>(
    () => [
      ...NAV.map((n) => ({ id: n.href, label: `Go to ${n.label}`, hint: `g ${n.key}`, icon: n.icon, run: () => router.push(n.href) })),
      { id: "theme", label: `Switch to ${theme === "dark" ? "light" : "dark"} mode`, icon: theme === "dark" ? Sun : Moon, run: toggle },
      { id: "help", label: "Show keyboard shortcuts", hint: "?", icon: Activity, run: () => setHelpOpen(true) },
    ],
    [router, theme, toggle],
  );

  const sidebar = (
    <>
      <div className="flex h-12 items-center gap-2 px-4">
        <span className="flex size-6 items-center justify-center rounded-md bg-accent text-[11px] font-bold text-accent-fg">OR</span>
        <span className="text-[13px] font-semibold tracking-tight">OpenRouter Studio</span>
      </div>
      <button
        type="button"
        onClick={() => setPaletteOpen(true)}
        className="mx-3 mb-2 flex h-8 items-center gap-2 rounded-md border border-line bg-panel px-2.5 text-xs text-faint hover:border-line-strong"
      >
        <Search className="size-3.5" aria-hidden />
        <span className="flex-1 text-left">Search…</span>
        <Kbd>⌘K</Kbd>
      </button>
      <nav aria-label="Main" className="flex-1 space-y-0.5 overflow-y-auto px-3 py-1">
        {NAV.map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setNavOpen(false)}
              aria-current={active ? "page" : undefined}
              className={cx(
                "flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] transition-colors",
                active ? "bg-hover font-medium text-fg" : "text-muted hover:bg-hover hover:text-fg",
              )}
            >
              <item.icon className="size-4" aria-hidden />
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="space-y-1 border-t border-line p-3">
        <KeyStatus />
        <button
          type="button"
          onClick={toggle}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted hover:bg-hover hover:text-fg"
        >
          {theme === "dark" ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
          {theme === "dark" ? "Light mode" : "Dark mode"}
        </button>
      </div>
    </>
  );

  return (
    <div className="flex h-full">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-panel focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <aside className="hidden w-56 shrink-0 flex-col border-r border-line bg-subtle md:flex">{sidebar}</aside>
      {navOpen ? (
        <div className="fixed inset-0 z-40 md:hidden">
          <button type="button" aria-label="Close menu" className="absolute inset-0 bg-black/40" onClick={() => setNavOpen(false)} />
          <aside className="relative flex h-full w-60 flex-col border-r border-line bg-subtle">{sidebar}</aside>
        </div>
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-12 items-center gap-2 border-b border-line px-3 md:hidden">
          <button type="button" aria-label="Open menu" onClick={() => setNavOpen(true)} className="rounded-md p-1.5 hover:bg-hover">
            <Menu className="size-4" />
          </button>
          <span className="text-[13px] font-semibold">OpenRouter Studio</span>
        </div>
        <BudgetAlerts />
        <main id="main" className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {children}
        </main>
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={commands} />
      <ShortcutHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <ShellInner>{children}</ShellInner>
    </SessionProvider>
  );
}
