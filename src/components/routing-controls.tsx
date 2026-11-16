"use client";

import { useResource } from "@/lib/client/api";
import type { ProviderInfo } from "@/lib/shared/models";
import { isAutoRouter, QUANTIZATIONS, type Routing } from "@/lib/shared/routing";
import { ModelPicker } from "./model-picker";
import { TagInput } from "./tag-input";
import { Chip, Field, Input, Select, Switch } from "./ui";
import { X } from "lucide-react";

function priceValue(raw: string): number | null {
  const n = Number(raw);
  return raw.trim() !== "" && Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Everything OpenRouter lets you say about *where* a request runs: fallback models,
 * the :nitro/:floor shortcuts, provider preferences and data-policy filters.
 */
export function RoutingControls({ model, value, onChange }: { model: string; value: Routing; onChange: (next: Routing) => void }) {
  const { data } = useResource<{ providers: ProviderInfo[] }>("/api/providers");
  const slugs = data?.providers.map((p) => p.slug) ?? [];
  const p = value.provider;
  const setProvider = (patch: Partial<Routing["provider"]>) => onChange({ ...value, provider: { ...p, ...patch } });

  return (
    <div className="space-y-4">
      <Field label="Fallback models" hint="tried in order">
        <div className="space-y-1.5">
          {value.fallbackModels.map((m, i) => (
            <div key={`${m}-${i}`} className="flex items-center gap-1.5">
              <span className="tabular w-4 text-xs text-faint">{i + 1}.</span>
              <ModelPicker
                value={m}
                ariaLabel={`Fallback model ${i + 1}`}
                onChange={(id) => onChange({ ...value, fallbackModels: value.fallbackModels.map((x, j) => (j === i ? id : x)) })}
                className="flex-1"
              />
              <button
                type="button"
                aria-label={`Remove fallback ${m}`}
                onClick={() => onChange({ ...value, fallbackModels: value.fallbackModels.filter((_, j) => j !== i) })}
                className="rounded p-1 text-faint hover:bg-hover hover:text-fg"
              >
                <X className="size-3.5" />
              </button>
            </div>
          ))}
          {value.fallbackModels.length < 8 ? (
            <ModelPicker
              value=""
              placeholder="Add a fallback model…"
              ariaLabel="Add fallback model"
              onChange={(id) => id !== model && !value.fallbackModels.includes(id) && onChange({ ...value, fallbackModels: [...value.fallbackModels, id] })}
            />
          ) : null}
        </div>
      </Field>

      <Field label="Speed / price shortcut">
        <div className="flex gap-1.5">
          {(
            [
              ["none", "Default"],
              ["nitro", ":nitro (fastest)"],
              ["floor", ":floor (cheapest)"],
            ] as const
          ).map(([v, label]) => (
            <Chip key={v} active={value.variant === v} onClick={() => onChange({ ...value, variant: v })}>
              {label}
            </Chip>
          ))}
        </div>
      </Field>

      {isAutoRouter(model) ? (
        <Field label="Auto Router: allowed models" hint="glob patterns">
          <TagInput
            ariaLabel="Allowed models for the auto router"
            placeholder="anthropic/*, openai/gpt-6*"
            value={value.autoAllowedModels}
            onChange={(next) => onChange({ ...value, autoAllowedModels: next })}
            max={30}
          />
        </Field>
      ) : null}

      <Field label="Sort providers by">
        <Select value={p.sort} onChange={(e) => setProvider({ sort: e.target.value as Routing["provider"]["sort"] })}>
          <option value="default">Default (price-weighted load balancing)</option>
          <option value="price">Lowest price</option>
          <option value="throughput">Highest throughput</option>
          <option value="latency">Lowest latency</option>
        </Select>
      </Field>

      <Field label="Provider order" hint="try these first">
        <TagInput ariaLabel="Provider order" placeholder="e.g. anthropic, google-vertex" suggestions={slugs} value={p.order} onChange={(order) => setProvider({ order })} max={20} />
      </Field>
      <Field label="Only these providers">
        <TagInput ariaLabel="Only these providers" placeholder="allow list" suggestions={slugs} value={p.only} onChange={(only) => setProvider({ only })} />
      </Field>
      <Field label="Ignore providers">
        <TagInput ariaLabel="Ignore providers" placeholder="block list" suggestions={slugs} value={p.ignore} onChange={(ignore) => setProvider({ ignore })} />
      </Field>

      <div className="space-y-2">
        <Switch checked={p.allowFallbacks} onChange={(allowFallbacks) => setProvider({ allowFallbacks })} label="Allow fallback providers" />
        <Switch checked={p.requireParameters} onChange={(requireParameters) => setProvider({ requireParameters })} label="Require support for every parameter sent" />
      </div>

      <fieldset className="space-y-2 rounded-md border border-line p-3">
        <legend className="px-1 text-xs font-medium text-muted">Data policy</legend>
        <Switch
          checked={p.dataCollection === "deny"}
          onChange={(deny) => setProvider({ dataCollection: deny ? "deny" : "allow" })}
          label="Skip providers that may store or train on prompts"
        />
        <Switch checked={p.zdr} onChange={(zdr) => setProvider({ zdr })} label="Zero Data Retention endpoints only" />
      </fieldset>

      <div className="grid grid-cols-2 gap-2">
        <Field label="Max input $/M">
          <Input inputMode="decimal" placeholder="no limit" value={p.maxPromptPrice ?? ""} onChange={(e) => setProvider({ maxPromptPrice: priceValue(e.target.value) })} />
        </Field>
        <Field label="Max output $/M">
          <Input inputMode="decimal" placeholder="no limit" value={p.maxCompletionPrice ?? ""} onChange={(e) => setProvider({ maxCompletionPrice: priceValue(e.target.value) })} />
        </Field>
      </div>

      <Field label="Quantization" hint="open-weight models">
        <div className="flex flex-wrap gap-1.5">
          {QUANTIZATIONS.map((q) => (
            <Chip
              key={q}
              active={p.quantizations.includes(q)}
              onClick={() => setProvider({ quantizations: p.quantizations.includes(q) ? p.quantizations.filter((x) => x !== q) : [...p.quantizations, q] })}
            >
              {q}
            </Chip>
          ))}
        </div>
      </Field>
    </div>
  );
}
