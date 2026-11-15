"use client";

import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { REASONING_EFFORTS, type Sampling } from "@/lib/shared/chat";
import { countRouting } from "@/lib/shared/routing";
import { RoutingControls } from "../routing-controls";
import { TagInput } from "../tag-input";
import { Badge, Chip, Field, Input, Select, Switch, Textarea } from "../ui";
import type { PlaygroundConfig } from "./use-playground";

export function Section({ title, badge, defaultOpen, children }: { title: string; badge?: ReactNode; defaultOpen?: boolean; children: ReactNode }) {
  return (
    <details open={defaultOpen} className="group border-b border-line">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-4 py-2.5 text-xs font-semibold tracking-wide text-muted uppercase select-none hover:text-fg">
        <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" aria-hidden />
        <span className="flex-1">{title}</span>
        {badge}
      </summary>
      <div className="space-y-3 px-4 pt-1 pb-4">{children}</div>
    </details>
  );
}

/** A numeric field where empty means "not set", so we only send what the user chose. */
export function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step,
  placeholder = "default",
}: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
}) {
  return (
    <Field label={label}>
      <Input
        type="number"
        min={min}
        max={max}
        step={step}
        placeholder={placeholder}
        value={value ?? ""}
        onChange={(e) => {
          const raw = e.target.value;
          const n = Number(raw);
          onChange(raw === "" || !Number.isFinite(n) ? null : n);
        }}
      />
    </Field>
  );
}

function samplingCount(s: Sampling): number {
  return [s.temperature, s.topP, s.topK, s.maxTokens, s.frequencyPenalty, s.presencePenalty, s.seed].filter((v) => v !== null).length + (s.stop.length ? 1 : 0);
}

export function SettingsPanel({
  config,
  onChange,
  primaryModel,
}: {
  config: PlaygroundConfig;
  onChange: (next: PlaygroundConfig) => void;
  primaryModel: string;
}) {
  const set = <K extends keyof PlaygroundConfig>(key: K, value: PlaygroundConfig[K]) => onChange({ ...config, [key]: value });
  const setSampling = (patch: Partial<Sampling>) => set("sampling", { ...config.sampling, ...patch });
  const setReasoning = (patch: Partial<PlaygroundConfig["reasoning"]>) => set("reasoning", { ...config.reasoning, ...patch });
  const routingCount = countRouting(config.routing);
  const sampled = samplingCount(config.sampling);

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <Section title="System prompt" defaultOpen badge={config.system.trim() ? <Badge tone="accent">set</Badge> : null}>
        <Textarea
          aria-label="System prompt"
          rows={5}
          placeholder="You are a helpful assistant…"
          value={config.system}
          onChange={(e) => set("system", e.target.value)}
        />
      </Section>

      <Section title="Endpoint">
        <div className="flex gap-1.5">
          <Chip active={config.api === "chat"} onClick={() => set("api", "chat")}>/chat/completions</Chip>
          <Chip active={config.api === "responses"} onClick={() => set("api", "responses")}>/responses</Chip>
        </div>
        <p className="text-xs text-faint">Both are proxied through this server. The Responses API is OpenRouter&apos;s newer, item-based format.</p>
      </Section>

      <Section title="Sampling" badge={sampled ? <Badge tone="accent">{sampled}</Badge> : null}>
        <div className="grid grid-cols-2 gap-2">
          <NumberField label="Temperature" min={0} max={2} step={0.1} value={config.sampling.temperature} onChange={(temperature) => setSampling({ temperature })} />
          <NumberField label="Top P" min={0} max={1} step={0.05} value={config.sampling.topP} onChange={(topP) => setSampling({ topP })} />
          <NumberField label="Top K" min={0} step={1} value={config.sampling.topK} onChange={(topK) => setSampling({ topK })} />
          <NumberField label="Max tokens" min={1} step={1} value={config.sampling.maxTokens} onChange={(maxTokens) => setSampling({ maxTokens })} />
          <NumberField label="Frequency penalty" min={-2} max={2} step={0.1} value={config.sampling.frequencyPenalty} onChange={(frequencyPenalty) => setSampling({ frequencyPenalty })} />
          <NumberField label="Presence penalty" min={-2} max={2} step={0.1} value={config.sampling.presencePenalty} onChange={(presencePenalty) => setSampling({ presencePenalty })} />
          <NumberField label="Seed" min={0} step={1} value={config.sampling.seed} onChange={(seed) => setSampling({ seed })} />
        </div>
        <Field label="Stop sequences" hint="chat/completions only">
          <TagInput ariaLabel="Stop sequences" placeholder="press Enter to add" value={config.sampling.stop} onChange={(stop) => setSampling({ stop })} max={4} />
        </Field>
      </Section>

      <Section title="Reasoning" badge={config.reasoning.mode !== "default" || config.reasoning.effort ? <Badge tone="accent">{config.reasoning.mode === "off" ? "off" : (config.reasoning.effort ?? "on")}</Badge> : null}>
        <div className="flex gap-1.5">
          {(
            [
              ["default", "Model default"],
              ["on", "On"],
              ["off", "Off"],
            ] as const
          ).map(([mode, label]) => (
            <Chip key={mode} active={config.reasoning.mode === mode} onClick={() => setReasoning({ mode })}>
              {label}
            </Chip>
          ))}
        </div>
        {config.reasoning.mode !== "off" ? (
          <>
            <Field label="Effort">
              <Select
                value={config.reasoning.effort ?? ""}
                onChange={(e) => setReasoning({ effort: (e.target.value || null) as PlaygroundConfig["reasoning"]["effort"] })}
              >
                <option value="">Model default</option>
                {REASONING_EFFORTS.map((e) => (
                  <option key={e} value={e}>{e}</option>
                ))}
              </Select>
            </Field>
            <NumberField label="Reasoning token budget" min={1} step={256} placeholder="none" value={config.reasoning.maxTokens} onChange={(maxTokens) => setReasoning({ maxTokens })} />
            <Switch checked={config.reasoning.exclude} onChange={(exclude) => setReasoning({ exclude })} label="Hide reasoning from the response" />
          </>
        ) : null}
      </Section>

      <Section title="Output format" badge={config.format !== "text" ? <Badge tone="accent">JSON</Badge> : null}>
        <div className="flex flex-wrap gap-1.5">
          <Chip active={config.format === "text"} onClick={() => set("format", "text")}>Text</Chip>
          <Chip active={config.format === "json_object"} onClick={() => set("format", "json_object")}>JSON object</Chip>
          <Chip active={config.format === "json_schema"} onClick={() => set("format", "json_schema")}>JSON schema</Chip>
        </div>
        {config.format === "json_schema" ? (
          <>
            <Field label="Schema name">
              <Input value={config.schemaName} onChange={(e) => set("schemaName", e.target.value)} />
            </Field>
            <Field label="JSON Schema">
              <Textarea
                rows={9}
                spellCheck={false}
                className="font-mono text-xs"
                value={config.schemaText}
                onChange={(e) => set("schemaText", e.target.value)}
              />
            </Field>
            <Switch checked={config.schemaStrict} onChange={(v) => set("schemaStrict", v)} label="Strict mode" />
          </>
        ) : null}
        {config.format === "json_object" ? <p className="text-xs text-faint">Ask for JSON in your prompt too; some providers require the word.</p> : null}
      </Section>

      <Section title="Routing" badge={routingCount ? <Badge tone="accent">{routingCount}</Badge> : null}>
        <RoutingControls model={primaryModel} value={config.routing} onChange={(routing) => set("routing", routing)} />
      </Section>

      <Section title="Files">
        <Field label="PDF engine" hint="for models without native file input">
          <Select value={config.pdfEngine} onChange={(e) => set("pdfEngine", e.target.value as PlaygroundConfig["pdfEngine"])}>
            <option value="auto">Automatic</option>
            <option value="native">Native (model reads the file)</option>
            <option value="cloudflare-ai">cloudflare-ai (free, text)</option>
            <option value="mistral-ocr">mistral-ocr (scans, paid per page)</option>
          </Select>
        </Field>
      </Section>
    </div>
  );
}
