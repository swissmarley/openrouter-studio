"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronsUpDown } from "lucide-react";
import { useModels } from "@/lib/client/models";
import { cx, pricePerM, tokens } from "@/lib/shared/format";
import type { ModelInfo } from "@/lib/shared/models";

const MAX_RESULTS = 60;

function rank(models: ModelInfo[], query: string, filter?: (m: ModelInfo) => boolean): ModelInfo[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const pool = filter ? models.filter(filter) : models;
  if (terms.length === 0) return pool.slice(0, MAX_RESULTS);
  const q = query.trim().toLowerCase();
  // Exact id first, then ids that start with the query, then everything else that matches.
  const score = (m: ModelInfo) => (m.id.toLowerCase() === q ? 0 : m.id.toLowerCase().startsWith(q) ? 1 : 2);
  return pool
    .filter((m) => {
      const hay = `${m.id} ${m.name}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    })
    .map((m, i) => ({ m, i, s: score(m) }))
    .sort((a, b) => a.s - b.s || a.m.id.length - b.m.id.length || a.i - b.i)
    .slice(0, MAX_RESULTS)
    .map((x) => x.m);
}

/**
 * Searchable model combobox. Any id can be entered by hand, since OpenRouter accepts
 * variants and aliases that are not listed individually.
 */
export function ModelPicker({
  value,
  onChange,
  filter,
  placeholder = "Select a model",
  className,
  ariaLabel = "Model",
}: {
  value: string;
  onChange: (id: string) => void;
  filter?: (m: ModelInfo) => boolean;
  placeholder?: string;
  className?: string;
  ariaLabel?: string;
}) {
  const { models, loading } = useModels();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();

  const results = useMemo(() => rank(models, query, filter), [models, query, filter]);
  // Offer a hand-typed id only when it is shaped like one ("author/slug"), never a search phrase.
  const typed = query.trim();
  const custom = /^~?[\w.-]+\/[\w.:-]+$/.test(typed) && !results.some((m) => m.id === typed) ? typed : null;
  const total = results.length + (custom ? 1 : 0);
  const current = models.find((m) => m.id === value);

  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  function choose(id: string) {
    onChange(id);
    setOpen(false);
    setQuery("");
  }

  return (
    <div ref={root} className={cx("relative min-w-0", className)}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((v) => !v)}
        className="flex h-8 w-full items-center gap-2 rounded-md border border-line bg-panel px-2.5 text-left text-[13px] hover:border-line-strong"
      >
        <span className={cx("min-w-0 flex-1 truncate font-mono text-xs", !value && "font-sans text-faint")}>{value || placeholder}</span>
        {current ? <span className="tabular hidden shrink-0 text-[11px] text-faint sm:inline">{pricePerM(current.pricing.prompt)} in</span> : null}
        <ChevronsUpDown className="size-3.5 shrink-0 text-faint" aria-hidden />
      </button>
      {open ? (
        <div className="absolute top-9 left-0 z-30 w-[min(28rem,calc(100vw-2rem))] rounded-lg border border-line bg-panel shadow-pop">
          <input
            ref={input}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={total ? `${listId}-${index}` : undefined}
            aria-label="Search models"
            placeholder={loading ? "Loading models…" : "Search, or type any model id…"}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setIndex(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setIndex((i) => Math.min(i + 1, total - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setIndex((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                if (index < results.length) choose(results[index].id);
                else if (custom) choose(custom);
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setOpen(false);
              }
            }}
            className="h-9 w-full border-b border-line bg-transparent px-3 text-[13px] outline-none placeholder:text-faint"
          />
          <ul id={listId} role="listbox" className="max-h-72 overflow-y-auto p-1">
            {results.map((m, i) => (
              <li
                key={m.id}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === index}
                onMouseEnter={() => setIndex(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(m.id)}
                className={cx("flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5", i === index && "bg-hover")}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px]">{m.name}</span>
                  <span className="block truncate font-mono text-[11px] text-muted">{m.id}</span>
                </span>
                <span className="tabular shrink-0 text-right text-[11px] text-faint">
                  {pricePerM(m.pricing.prompt)} / {pricePerM(m.pricing.completion)}
                  <br />
                  {tokens(m.contextLength)} ctx
                </span>
              </li>
            ))}
            {custom ? (
              <li
                id={`${listId}-${results.length}`}
                role="option"
                aria-selected={index === results.length}
                onMouseEnter={() => setIndex(results.length)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(custom)}
                className={cx("cursor-pointer rounded-md px-2 py-1.5 text-[13px]", index === results.length && "bg-hover")}
              >
                Use <span className="font-mono text-xs">{custom}</span>
              </li>
            ) : null}
            {total === 0 ? <li className="px-2 py-4 text-center text-xs text-muted">{loading ? "Loading…" : "No models found."}</li> : null}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
