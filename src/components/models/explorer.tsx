"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { Check, Copy, GitCompareArrows, MessageSquare, RefreshCw, X } from "lucide-react";
import { useResource } from "@/lib/client/api";
import { useModels } from "@/lib/client/models";
import { cx, pricePerM, tokens } from "@/lib/shared/format";
import { countActive, emptyFilters, filterModels, type ModelFilters, type SortKey } from "@/lib/shared/model-filter";
import { CAPABILITIES, type EndpointInfo, type ModelInfo } from "@/lib/shared/models";
import { Badge, Button, Chip, Dialog, EmptyState, Input, Notice, PageHeader, Select, Spinner, Switch } from "../ui";

const INPUT_MODALITIES = ["text", "image", "file", "audio", "video"];
const OUTPUT_MODALITIES = ["text", "image", "audio"];
const CONTEXT_OPTIONS = [
  { label: "Any context", value: 0 },
  { label: "≥ 32K", value: 32_000 },
  { label: "≥ 128K", value: 128_000 },
  { label: "≥ 200K", value: 200_000 },
  { label: "≥ 1M", value: 1_000_000 },
];
const MAX_COMPARE = 4;
const PAGE = 80;

function toggle<T>(list: T[], item: T): T[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
}

function parsePrice(raw: string): number | null {
  if (raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function CopyId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title="Copy model id"
      onClick={async (e) => {
        e.stopPropagation();
        await navigator.clipboard.writeText(id);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      className="inline-flex items-center gap-1 rounded px-1 font-mono text-xs text-muted hover:bg-hover hover:text-fg"
    >
      {id}
      {copied ? <Check className="size-3 text-ok" /> : <Copy className="size-3 opacity-60" />}
    </button>
  );
}

function useEndpoints(modelId: string | null) {
  return useResource<{ endpoints: EndpointInfo[] }>(modelId ? `/api/models/endpoints?id=${encodeURIComponent(modelId)}` : null);
}

function EndpointsTable({ modelId }: { modelId: string }) {
  const { data, loading, error } = useEndpoints(modelId);
  if (loading) return <div className="flex justify-center py-6"><Spinner /></div>;
  if (error) return <Notice tone="warn">Could not load provider endpoints: {error.message}</Notice>;
  const endpoints = data?.endpoints ?? [];
  if (endpoints.length === 0) return <p className="text-[13px] text-muted">No provider endpoints are listed for this model.</p>;
  return (
    <div className="overflow-x-auto rounded-md border border-line">
      <table className="tabular w-full text-left text-xs">
        <thead className="bg-subtle text-muted">
          <tr>
            {["Provider", "Input /M", "Output /M", "Context", "Max out", "Quant.", "Latency p50", "Tokens/s p50", "Uptime 30m"].map((h) => (
              <th key={h} className="px-2.5 py-1.5 font-medium whitespace-nowrap">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {endpoints.map((e) => (
            <tr key={e.tag + e.providerName} className="border-t border-line">
              <td className="px-2.5 py-1.5">
                <span className="font-medium">{e.providerName}</span>
                <span className="ml-1.5 font-mono text-[11px] text-faint">{e.tag}</span>
              </td>
              <td className="px-2.5 py-1.5">{pricePerM(e.pricing.prompt)}</td>
              <td className="px-2.5 py-1.5">{pricePerM(e.pricing.completion)}</td>
              <td className="px-2.5 py-1.5">{tokens(e.contextLength)}</td>
              <td className="px-2.5 py-1.5">{tokens(e.maxCompletionTokens)}</td>
              <td className="px-2.5 py-1.5">{e.quantization ?? "—"}</td>
              <td className="px-2.5 py-1.5">{e.latencyP50Ms !== null ? `${Math.round(e.latencyP50Ms)}ms` : "—"}</td>
              <td className="px-2.5 py-1.5">{e.throughputP50 !== null ? Math.round(e.throughputP50) : "—"}</td>
              <td className="px-2.5 py-1.5">{e.uptime30m !== null ? `${e.uptime30m.toFixed(1)}%` : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ModelDetail({ model, onClose }: { model: ModelInfo | null; onClose: () => void }) {
  return (
    <Dialog
      open={model !== null}
      onClose={onClose}
      wide
      title={model?.name ?? ""}
      footer={
        model ? (
          <Link
            href={`/chat?model=${encodeURIComponent(model.id)}`}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-[13px] font-medium text-accent-fg hover:bg-accent-hover"
          >
            <MessageSquare className="size-3.5" /> Open in chat
          </Link>
        ) : null
      }
    >
      {model ? (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            <CopyId id={model.id} />
            {model.aliasOf ? <Badge tone="accent">alias of {model.aliasOf}</Badge> : null}
            {model.moderated ? <Badge>moderated</Badge> : null}
            {model.expiresAt ? <Badge tone="warn">retires {model.expiresAt}</Badge> : null}
          </div>
          <p className="max-h-40 overflow-y-auto text-[13px] leading-relaxed whitespace-pre-line text-muted">{model.description}</p>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
            {(
              [
                ["Context", tokens(model.contextLength)],
                ["Max output", tokens(model.maxCompletionTokens)],
                ["Input /M", pricePerM(model.pricing.prompt)],
                ["Output /M", pricePerM(model.pricing.completion)],
                ["Cache read /M", pricePerM(model.pricing.cacheRead)],
                ["Cache write /M", pricePerM(model.pricing.cacheWrite)],
                ["Per image", model.pricing.image !== null ? `$${model.pricing.image}` : "—"],
                ["Tokenizer", model.tokenizer ?? "—"],
              ] as const
            ).map(([k, v]) => (
              <div key={k}>
                <dt className="text-xs text-muted">{k}</dt>
                <dd className="tabular text-[13px] font-medium">{v}</dd>
              </div>
            ))}
          </dl>
          <div>
            <h3 className="mb-1.5 text-xs font-medium text-muted">Modalities</h3>
            <p className="text-[13px]">
              {model.inputModalities.join(", ")} <span className="text-faint">→</span> {model.outputModalities.join(", ")}
            </p>
          </div>
          {model.reasoning ? (
            <div>
              <h3 className="mb-1.5 text-xs font-medium text-muted">Reasoning</h3>
              <p className="text-[13px]">
                {model.reasoning.mandatory ? "Always on" : model.reasoning.defaultEnabled ? "On by default" : "Off by default"}
                {model.reasoning.supportedEfforts?.length ? ` · efforts: ${model.reasoning.supportedEfforts.join(", ")}` : ""}
                {model.reasoning.supportsMaxTokens ? " · token budget supported" : ""}
              </p>
            </div>
          ) : null}
          <div>
            <h3 className="mb-1.5 text-xs font-medium text-muted">Supported parameters</h3>
            <div className="flex flex-wrap gap-1">
              {model.supportedParameters.map((p) => (
                <Badge key={p} className="font-mono">{p}</Badge>
              ))}
            </div>
          </div>
          <div>
            <h3 className="mb-1.5 text-xs font-medium text-muted">Provider endpoints (live)</h3>
            <EndpointsTable modelId={model.id} />
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}

function EndpointSummary({ modelId }: { modelId: string }) {
  const { data, loading } = useEndpoints(modelId);
  if (loading) return <Spinner className="size-3.5" />;
  const eps = data?.endpoints ?? [];
  if (eps.length === 0) return <span className="text-faint">—</span>;
  const min = (vals: (number | null)[]) => {
    const v = vals.filter((x): x is number => x !== null);
    return v.length ? Math.min(...v) : null;
  };
  const max = (vals: (number | null)[]) => {
    const v = vals.filter((x): x is number => x !== null);
    return v.length ? Math.max(...v) : null;
  };
  const latency = min(eps.map((e) => e.latencyP50Ms));
  const throughput = max(eps.map((e) => e.throughputP50));
  return (
    <ul className="space-y-0.5">
      <li>{eps.length} provider{eps.length === 1 ? "" : "s"}</li>
      <li className="text-muted">cheapest in {pricePerM(min(eps.map((e) => e.pricing.prompt)))}</li>
      <li className="text-muted">{latency !== null ? `fastest ${Math.round(latency)}ms p50` : "no latency data"}</li>
      <li className="text-muted">{throughput !== null ? `up to ${Math.round(throughput)} tok/s` : "no throughput data"}</li>
    </ul>
  );
}

/** Side-by-side comparison. The best value in each numeric row is highlighted. */
function CompareDialog({ models, open, onClose }: { models: ModelInfo[]; open: boolean; onClose: () => void }) {
  type Row = { label: string; render: (m: ModelInfo) => React.ReactNode; best?: (m: ModelInfo) => number | null; lowerIsBetter?: boolean };
  const rows: Row[] = [
    { label: "Context window", render: (m) => tokens(m.contextLength), best: (m) => m.contextLength },
    { label: "Max output", render: (m) => tokens(m.maxCompletionTokens), best: (m) => m.maxCompletionTokens },
    { label: "Input price /M", render: (m) => pricePerM(m.pricing.prompt), best: (m) => (m.pricing.prompt < 0 ? null : m.pricing.prompt), lowerIsBetter: true },
    { label: "Output price /M", render: (m) => pricePerM(m.pricing.completion), best: (m) => (m.pricing.completion < 0 ? null : m.pricing.completion), lowerIsBetter: true },
    { label: "Cache read /M", render: (m) => pricePerM(m.pricing.cacheRead) },
    { label: "Input modalities", render: (m) => m.inputModalities.join(", ") },
    { label: "Output modalities", render: (m) => m.outputModalities.join(", ") },
    ...CAPABILITIES.map((c): Row => ({
      label: c.label,
      render: (m) => (m.supportedParameters.includes(c.param) ? <Check className="size-4 text-ok" aria-label="yes" /> : <X className="size-4 text-faint" aria-label="no" />),
    })),
    {
      label: "Reasoning efforts",
      render: (m) => (m.reasoning ? m.reasoning.supportedEfforts?.join(", ") || (m.reasoning.mandatory ? "always on" : "on/off") : "—"),
    },
    { label: "Released", render: (m) => (m.created ? new Date(m.created * 1000).toLocaleDateString() : "—") },
    { label: "Providers (live)", render: (m) => <EndpointSummary modelId={m.id} /> },
  ];

  function bestIds(row: Row): Set<string> {
    if (!row.best || models.length < 2) return new Set();
    const scored = models.map((m) => [m.id, row.best!(m)] as const).filter((x): x is readonly [string, number] => x[1] !== null);
    if (scored.length < 2) return new Set();
    const target = row.lowerIsBetter ? Math.min(...scored.map((x) => x[1])) : Math.max(...scored.map((x) => x[1]));
    // If everything ties there is no "best" worth pointing at.
    if (scored.every((x) => x[1] === target)) return new Set();
    return new Set(scored.filter((x) => x[1] === target).map((x) => x[0]));
  }

  return (
    <Dialog open={open} onClose={onClose} wide="xl" title={`Compare ${models.length} models`}>
      <div className="overflow-x-auto">
        <table className="w-full table-fixed text-left text-[13px]">
          <thead>
            <tr>
              <th className="w-40 p-2" />
              {models.map((m) => (
                <th key={m.id} className="p-2 align-top font-normal">
                  <p className="font-semibold">{m.name}</p>
                  <p className="mt-0.5 font-mono text-[11px] break-all text-muted">{m.id}</p>
                  <Link href={`/chat?model=${encodeURIComponent(m.id)}`} className="mt-1 inline-block text-xs text-accent-text underline">
                    Open in chat
                  </Link>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const best = bestIds(row);
              return (
                <tr key={row.label} className="border-t border-line">
                  <th scope="row" className="p-2 text-xs font-medium text-muted">{row.label}</th>
                  {models.map((m) => (
                    <td key={m.id} className={cx("tabular p-2 align-top", best.has(m.id) && "font-semibold text-ok")}>
                      {row.render(m)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Dialog>
  );
}

export function ModelExplorer() {
  const { models, loading, error, refresh } = useModels();
  const [filters, setFiltersRaw] = useState<ModelFilters>(emptyFilters);
  const [limit, setLimit] = useState(PAGE);
  // Any filter change starts the list again from the first page.
  const setFilters = (next: ModelFilters | ((f: ModelFilters) => ModelFilters)) => {
    setFiltersRaw(next);
    setLimit(PAGE);
  };
  const [selected, setSelected] = useState<string[]>([]);
  const [detail, setDetail] = useState<ModelInfo | null>(null);
  const [comparing, setComparing] = useState(false);
  const tbody = useRef<HTMLTableSectionElement>(null);

  const set = <K extends keyof ModelFilters>(key: K, value: ModelFilters[K]) => setFilters((f) => ({ ...f, [key]: value }));

  const authors = useMemo(() => [...new Set(models.map((m) => m.author))].sort(), [models]);
  const filtered = useMemo(() => filterModels(models, filters), [models, filters]);
  const shown = filtered.slice(0, limit);
  const compared = useMemo(() => selected.map((id) => models.find((m) => m.id === id)).filter((m): m is ModelInfo => !!m), [selected, models]);
  const active = countActive(filters);

  function toggleSelected(id: string) {
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : cur.length >= MAX_COMPARE ? cur : [...cur, id]));
  }

  function onRowKey(e: React.KeyboardEvent<HTMLTableRowElement>, model: ModelInfo) {
    const row = e.currentTarget;
    if (e.key === "Enter") {
      e.preventDefault();
      setDetail(model);
    } else if (e.key === " " || e.key === "c") {
      e.preventDefault();
      toggleSelected(model.id);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      (row.nextElementSibling as HTMLElement | null)?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      (row.previousElementSibling as HTMLElement | null)?.focus();
    }
  }

  return (
    <>
      <PageHeader
        title="Models"
        description={
          loading ? "Loading the live catalog…" : `${filtered.length} of ${models.length} models, fetched live from OpenRouter. Prices are per million tokens.`
        }
        actions={
          <Button icon={<RefreshCw className="size-3.5" />} onClick={() => void refresh()} loading={loading && models.length > 0}>
            Refresh
          </Button>
        }
      />

      <section aria-label="Filters" className="space-y-3 border-b border-line px-6 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            data-page-search
            type="search"
            placeholder="Search by name or id…  ( / )"
            aria-label="Search models"
            value={filters.query}
            onChange={(e) => set("query", e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                (tbody.current?.firstElementChild as HTMLElement | null)?.focus();
              }
            }}
            className="w-64"
          />
          <Select aria-label="Author" value={filters.author} onChange={(e) => set("author", e.target.value)} className="w-40">
            <option value="">All authors</option>
            {authors.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </Select>
          <Select aria-label="Minimum context" value={filters.minContext} onChange={(e) => set("minContext", Number(e.target.value))} className="w-32">
            {CONTEXT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </Select>
          <label className="flex items-center gap-1.5 text-xs text-muted">
            Max input $/M
            <Input
              inputMode="decimal"
              placeholder="any"
              aria-label="Maximum input price per million tokens"
              value={filters.maxPromptPrice ?? ""}
              onChange={(e) => set("maxPromptPrice", parsePrice(e.target.value))}
              className="w-16"
            />
          </label>
          <label className="flex items-center gap-1.5 text-xs text-muted">
            Max output $/M
            <Input
              inputMode="decimal"
              placeholder="any"
              aria-label="Maximum output price per million tokens"
              value={filters.maxCompletionPrice ?? ""}
              onChange={(e) => set("maxCompletionPrice", parsePrice(e.target.value))}
              className="w-16"
            />
          </label>
          <Switch checked={filters.freeOnly} onChange={(v) => set("freeOnly", v)} label="Free only" />
          <Select aria-label="Sort" value={filters.sort} onChange={(e) => set("sort", e.target.value as SortKey)} className="ml-auto w-40">
            <option value="newest">Newest first</option>
            <option value="price-asc">Cheapest first</option>
            <option value="price-desc">Most expensive first</option>
            <option value="context">Largest context</option>
            <option value="name">Name A–Z</option>
          </Select>
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted">Input</span>
            {INPUT_MODALITIES.map((m) => (
              <Chip key={m} active={filters.inputModalities.includes(m)} onClick={() => set("inputModalities", toggle(filters.inputModalities, m))}>
                {m}
              </Chip>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted">Output</span>
            {OUTPUT_MODALITIES.map((m) => (
              <Chip key={m} active={filters.outputModalities.includes(m)} onClick={() => set("outputModalities", toggle(filters.outputModalities, m))}>
                {m}
              </Chip>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted">Supports</span>
            {CAPABILITIES.map((c) => (
              <Chip key={c.key} active={filters.params.includes(c.param)} onClick={() => set("params", toggle(filters.params, c.param))}>
                {c.label}
              </Chip>
            ))}
          </div>
          {active > 0 ? (
            <Button variant="ghost" size="sm" onClick={() => setFilters({ ...emptyFilters, sort: filters.sort })}>
              Clear {active} filter{active === 1 ? "" : "s"}
            </Button>
          ) : null}
        </div>
      </section>

      {error ? (
        <div className="p-6">
          <Notice tone="err">Could not load models: {error}</Notice>
        </div>
      ) : loading && models.length === 0 ? (
        <div className="flex flex-1 items-center justify-center"><Spinner /></div>
      ) : filtered.length === 0 ? (
        <EmptyState title="No models match these filters" action={<Button onClick={() => setFilters(emptyFilters)}>Clear filters</Button>}>
          Try loosening a price ceiling or removing a capability.
        </EmptyState>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full text-left text-[13px]">
            <thead className="sticky top-0 z-10 bg-bg text-xs text-muted shadow-[0_1px_0_var(--line)]">
              <tr>
                <th className="w-10 py-2 pl-6"><span className="sr-only">Compare</span></th>
                <th className="px-2 py-2 font-medium">Model</th>
                <th className="px-2 py-2 text-right font-medium">Context</th>
                <th className="px-2 py-2 text-right font-medium">Input /M</th>
                <th className="px-2 py-2 text-right font-medium">Output /M</th>
                <th className="px-2 py-2 font-medium">Modalities</th>
                <th className="py-2 pr-6 pl-2 font-medium">Capabilities</th>
              </tr>
            </thead>
            <tbody ref={tbody}>
              {shown.map((m) => {
                const isSelected = selected.includes(m.id);
                return (
                  <tr
                    key={m.id}
                    tabIndex={0}
                    onClick={() => setDetail(m)}
                    onKeyDown={(e) => onRowKey(e, m)}
                    className={cx("cursor-pointer border-b border-line outline-offset-[-2px] hover:bg-subtle", isSelected && "bg-accent-soft/50")}
                  >
                    <td className="py-2 pl-6" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        aria-label={`Compare ${m.name}`}
                        checked={isSelected}
                        disabled={!isSelected && selected.length >= MAX_COMPARE}
                        onChange={() => toggleSelected(m.id)}
                        className="size-3.5 accent-[var(--accent)]"
                      />
                    </td>
                    <td className="max-w-md px-2 py-2">
                      <p className="truncate font-medium">{m.name}</p>
                      <p className="truncate font-mono text-[11px] text-muted">{m.id}</p>
                    </td>
                    <td className="tabular px-2 py-2 text-right">{tokens(m.contextLength)}</td>
                    <td className="tabular px-2 py-2 text-right">{pricePerM(m.pricing.prompt)}</td>
                    <td className="tabular px-2 py-2 text-right">{pricePerM(m.pricing.completion)}</td>
                    <td className="px-2 py-2 text-xs text-muted">
                      {m.inputModalities.join(" · ")}
                      {m.outputModalities.some((o) => o !== "text") ? <span className="text-accent-text"> → {m.outputModalities.join(" · ")}</span> : null}
                    </td>
                    <td className="py-2 pr-6 pl-2">
                      <div className="flex flex-wrap gap-1">
                        {CAPABILITIES.slice(0, 3).map((c) =>
                          m.supportedParameters.includes(c.param) ? <Badge key={c.key}>{c.label.toLowerCase()}</Badge> : null,
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {filtered.length > limit ? (
            <div className="flex justify-center py-4">
              <Button onClick={() => setLimit((l) => l + PAGE)}>Show {Math.min(PAGE, filtered.length - limit)} more</Button>
            </div>
          ) : null}
        </div>
      )}

      {selected.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-line bg-panel px-6 py-2.5">
          <span className="text-xs text-muted">Comparing {selected.length}/{MAX_COMPARE}</span>
          {compared.map((m) => (
            <Badge key={m.id} tone="accent">
              {m.name}
              <button type="button" aria-label={`Remove ${m.name}`} onClick={() => toggleSelected(m.id)} className="ml-0.5 rounded hover:bg-black/10">
                <X className="size-3" />
              </button>
            </Badge>
          ))}
          <div className="ml-auto flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => setSelected([])}>Clear</Button>
            <Button variant="primary" size="sm" icon={<GitCompareArrows className="size-3.5" />} disabled={selected.length < 2} onClick={() => setComparing(true)}>
              Compare side by side
            </Button>
          </div>
        </div>
      ) : null}

      <ModelDetail model={detail} onClose={() => setDetail(null)} />
      <CompareDialog models={compared} open={comparing} onClose={() => setComparing(false)} />
    </>
  );
}
