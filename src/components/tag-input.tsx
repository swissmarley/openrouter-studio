"use client";

import { useId, useState } from "react";
import { X } from "lucide-react";

/** An ordered list of short strings, edited as removable chips. Enter or comma adds. */
export function TagInput({
  value,
  onChange,
  placeholder,
  suggestions,
  ariaLabel,
  max = 40,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  suggestions?: string[];
  ariaLabel: string;
  max?: number;
}) {
  const [draft, setDraft] = useState("");
  const listId = useId();

  function add(raw: string) {
    const items = raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s && !value.includes(s));
    if (items.length) onChange([...value, ...items].slice(0, max));
    setDraft("");
  }

  return (
    <div className="flex min-h-8 flex-wrap items-center gap-1 rounded-md border border-line bg-panel px-1.5 py-1 focus-within:border-accent hover:border-line-strong">
      {value.map((item, i) => (
        <span key={item} className="inline-flex items-center gap-1 rounded bg-subtle py-0.5 pr-1 pl-1.5 font-mono text-[11px]">
          {value.length > 1 ? <span className="text-faint">{i + 1}.</span> : null}
          {item}
          <button
            type="button"
            aria-label={`Remove ${item}`}
            onClick={() => onChange(value.filter((v) => v !== item))}
            className="rounded text-faint hover:bg-hover hover:text-fg"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input
        aria-label={ariaLabel}
        list={suggestions ? listId : undefined}
        value={draft}
        placeholder={value.length === 0 ? placeholder : undefined}
        onChange={(e) => {
          // Picking a datalist option fires change with the full value: add it right away.
          if (suggestions?.includes(e.target.value)) add(e.target.value);
          else setDraft(e.target.value);
        }}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === ",") && draft.trim()) {
            e.preventDefault();
            add(draft);
          } else if (e.key === "Backspace" && !draft && value.length) {
            onChange(value.slice(0, -1));
          }
        }}
        onBlur={() => draft.trim() && add(draft)}
        className="h-6 min-w-24 flex-1 bg-transparent px-1 text-[13px] outline-none placeholder:text-faint"
      />
      {suggestions ? (
        <datalist id={listId}>
          {suggestions.filter((s) => !value.includes(s)).map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      ) : null}
    </div>
  );
}
