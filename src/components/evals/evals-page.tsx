"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { ArrowLeft, FlaskConical, Plus, Square, Trash2, X } from "lucide-react";
import { api, ApiClientError, useResource } from "@/lib/client/api";
import { parseDataset, SCORERS, summarize, type EvalConfig, type EvalResult, type EvalRow, type EvalSummary, type ModelStats, type ScorerId } from "@/lib/shared/evals";
import { cx, duration, timeAgo, tokens, usd } from "@/lib/shared/format";
import type { Settings } from "@/lib/shared/settings";
import { Markdown } from "../markdown";
import { ModelPicker } from "../model-picker";
import { NumberField } from "../chat/settings-panel";
import { Badge, Button, Card, Chip, Dialog, EmptyState, Field, Input, Notice, PageHeader, Select, Spinner, Textarea } from "../ui";

const STATUS_TONE = { running: "accent", completed: "ok", failed: "err", cancelled: "neutral" } as const;

interface Dataset {
  id: string;
  name: string;
  rows: EvalRow[];
}

const scoreText = (score: number | null) => (score === null ? "—" : `${Math.round(score * 100)}%`);

/* ---------- new eval ---------- */

function NewEval({ onStarted, onCancel }: { onStarted: (id: string) => void; onCancel: () => void }) {
  const settings = useResource<{ settings: Settings }>("/api/settings");
  const datasets = useResource<{ datasets: Dataset[] }>("/api/evals/datasets");
  const defaults = settings.data?.settings.defaults;

  const [name, setName] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [system, setSystem] = useState("");
  const [mode, setMode] = useState<"single" | "dataset">("single");
  const [prompt, setPrompt] = useState("");
  const [expected, setExpected] = useState("");
  const [datasetText, setDatasetText] = useState("");
  const [datasetName, setDatasetName] = useState("");
  const [scorer, setScorer] = useState<ScorerId>("none");
  const [judgeModel, setJudgeModel] = useState<string | null>(null);
  const [rubric, setRubric] = useState("Score how correct, complete and directly useful the answer is.");
  const [temperature, setTemperature] = useState<number | null>(0);
  const [maxTokens, setMaxTokens] = useState<number | null>(1024);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsed = useMemo(() => {
    if (mode === "single") return { rows: prompt.trim() ? [{ input: prompt, ...(expected.trim() ? { expected } : {}) }] : [], error: null };
    if (!datasetText.trim()) return { rows: [], error: null };
    try {
      return { rows: parseDataset(datasetText), error: null };
    } catch (err) {
      return { rows: [] as EvalRow[], error: (err as Error).message };
    }
  }, [mode, prompt, expected, datasetText]);

  const scorerInfo = SCORERS.find((s) => s.id === scorer)!;
  const judge = judgeModel ?? defaults?.judgeModel ?? "";
  const missingExpected = scorerInfo.needsExpected ? parsed.rows.filter((r) => r.expected === undefined).length : 0;
  const calls = parsed.rows.length * models.length * (scorer === "judge" ? 2 : 1);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      if (mode === "dataset" && datasetName.trim()) {
        await api.post("/api/evals/datasets", { name: datasetName.trim(), rows: parsed.rows });
      }
      const body: Partial<EvalConfig> = {
        name: name.trim() || (mode === "single" ? prompt.trim().slice(0, 60) : datasetName.trim() || "Untitled eval"),
        models,
        system,
        rows: parsed.rows,
        scorer,
        judgeModel: scorer === "judge" ? judge : "",
        rubric,
        temperature,
        maxTokens,
      };
      const res = await api.post<{ id: string }>("/api/evals", body);
      onStarted(res.id);
    } catch (err) {
      const fields = err instanceof ApiClientError ? (err.details as { fieldErrors?: Record<string, string[]> } | undefined)?.fieldErrors : undefined;
      setError((fields ? Object.values(fields).flat()[0] : undefined) ?? (err instanceof ApiClientError ? err.message : "Could not start the eval."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-5 px-6 py-5">
        <Field label="Name" hint="optional">
          <Input placeholder="Capital cities, short answers" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>

        <Field label="Models to compare" hint={`${models.length} of 8`}>
          <div className="space-y-1.5">
            {models.map((m, i) => (
              <div key={`${m}-${i}`} className="flex items-center gap-1.5">
                <ModelPicker value={m} ariaLabel={`Model ${i + 1}`} onChange={(id) => setModels(models.map((x, j) => (j === i ? id : x)))} className="flex-1" />
                <button type="button" aria-label={`Remove ${m}`} onClick={() => setModels(models.filter((_, j) => j !== i))} className="rounded p-1 text-faint hover:bg-hover hover:text-fg">
                  <X className="size-3.5" />
                </button>
              </div>
            ))}
            {models.length < 8 ? <ModelPicker value="" placeholder="Add a model…" ariaLabel="Add model" onChange={(id) => !models.includes(id) && setModels([...models, id])} /> : null}
          </div>
        </Field>

        <Field label="System prompt" hint="optional, sent to every model">
          <Textarea rows={2} value={system} onChange={(e) => setSystem(e.target.value)} />
        </Field>

        <div>
          <div className="mb-2 flex gap-1.5">
            <Chip active={mode === "single"} onClick={() => setMode("single")}>One prompt</Chip>
            <Chip active={mode === "dataset"} onClick={() => setMode("dataset")}>Dataset</Chip>
          </div>
          {mode === "single" ? (
            <div className="space-y-3">
              <Field label="Prompt">
                <Textarea rows={4} placeholder="What is the capital of Australia? Answer with the city name only." value={prompt} onChange={(e) => setPrompt(e.target.value)} />
              </Field>
              <Field label="Expected answer" hint="optional, used by the scorer">
                <Input placeholder="Canberra" value={expected} onChange={(e) => setExpected(e.target.value)} />
              </Field>
            </div>
          ) : (
            <div className="space-y-3">
              {datasets.data?.datasets.length ? (
                <Field label="Load a saved dataset">
                  <Select
                    value=""
                    onChange={(e) => {
                      const ds = datasets.data?.datasets.find((d) => d.id === e.target.value);
                      if (ds) setDatasetText(JSON.stringify(ds.rows, null, 2));
                    }}
                  >
                    <option value="">Choose…</option>
                    {datasets.data.datasets.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name} ({d.rows.length} rows)
                      </option>
                    ))}
                  </Select>
                </Field>
              ) : null}
              <Field label="Rows" hint="JSON array, JSON Lines, or CSV with input / expected columns" error={parsed.error}>
                <Textarea
                  rows={8}
                  spellCheck={false}
                  className="font-mono text-xs"
                  placeholder={'input,expected\n"What is 2+2?",4\n"Capital of France?",Paris'}
                  value={datasetText}
                  onChange={(e) => setDatasetText(e.target.value)}
                />
              </Field>
              <div className="flex flex-wrap items-center gap-3">
                <span className="tabular text-xs text-muted">{parsed.rows.length} row{parsed.rows.length === 1 ? "" : "s"} parsed</span>
                <Input aria-label="Save this dataset as" placeholder="Save as dataset (optional name)" value={datasetName} onChange={(e) => setDatasetName(e.target.value)} className="w-64" />
              </div>
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Quality scoring">
            <Select value={scorer} onChange={(e) => setScorer(e.target.value as ScorerId)}>
              {SCORERS.map((s) => (
                <option key={s.id} value={s.id}>{s.label}</option>
              ))}
            </Select>
          </Field>
          <p className="self-end pb-1.5 text-xs text-muted">{scorerInfo.help}</p>
        </div>
        {missingExpected > 0 ? (
          <Notice tone="warn">
            {missingExpected === parsed.rows.length
              ? `No row has an expected answer, so ${scorerInfo.label.toLowerCase()} cannot score anything.`
              : `${missingExpected} row${missingExpected === 1 ? " has" : "s have"} no expected answer, so ${scorerInfo.label.toLowerCase()} cannot score ${missingExpected === 1 ? "it" : "them"}.`}
          </Notice>
        ) : null}
        {scorer === "judge" ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Judge model">
              <ModelPicker value={judge} onChange={setJudgeModel} ariaLabel="Judge model" />
            </Field>
            <Field label="Rubric">
              <Textarea rows={2} value={rubric} onChange={(e) => setRubric(e.target.value)} />
            </Field>
          </div>
        ) : null}

        <div className="grid grid-cols-2 gap-3">
          <NumberField label="Temperature" min={0} max={2} step={0.1} value={temperature} onChange={setTemperature} />
          <NumberField label="Max tokens per answer" min={1} step={256} value={maxTokens} onChange={setMaxTokens} />
        </div>

        {error ? <Notice tone="err">{error}</Notice> : null}
        <div className="flex items-center gap-3">
          <Button variant="primary" icon={<FlaskConical className="size-3.5" />} loading={busy} disabled={models.length === 0 || parsed.rows.length === 0 || parsed.error !== null} onClick={() => void start()}>
            Run eval
          </Button>
          <Button onClick={onCancel}>Cancel</Button>
          {calls > 0 ? <span className="tabular text-xs text-muted">{calls} model call{calls === 1 ? "" : "s"}</span> : null}
        </div>
      </div>
    </div>
  );
}

/* ---------- results ---------- */

/** Marks the best model in a column, unless everyone ties. */
function best(stats: ModelStats[], pick: (s: ModelStats) => number | null, lowerIsBetter: boolean): Set<string> {
  const scored = stats.map((s) => [s.model, pick(s)] as const).filter((x): x is readonly [string, number] => x[1] !== null);
  if (scored.length < 2) return new Set();
  const target = lowerIsBetter ? Math.min(...scored.map((x) => x[1])) : Math.max(...scored.map((x) => x[1]));
  if (scored.every((x) => x[1] === target)) return new Set();
  return new Set(scored.filter((x) => x[1] === target).map((x) => x[0]));
}

function ScoreBadge({ result }: { result: EvalResult }) {
  if (result.error) return <Badge tone="err">error</Badge>;
  if (result.score === null) return null;
  return <Badge tone={result.score >= 0.8 ? "ok" : result.score >= 0.5 ? "warn" : "err"}>{scoreText(result.score)}</Badge>;
}

function EvalView({ id }: { id: string }) {
  const router = useRouter();
  // Polls while the eval is running, and stops by itself once it has settled.
  const { data, error, loading, reload } = useResource<{ eval: EvalSummary; results: EvalResult[] }>(`/api/evals/${id}`, {
    pollMs: 1500,
    pollWhile: (d) => d.eval.status === "running",
  });
  const [open, setOpen] = useState<EvalResult | null>(null);
  const running = data?.eval.status === "running";

  const stats = useMemo(() => (data ? summarize(data.eval.config.models, data.results) : []), [data]);

  if (loading && !data) return <div className="flex flex-1 items-center justify-center"><Spinner /></div>;
  if (!data) {
    return (
      <EmptyState title="This eval could not be loaded" action={<Link href="/evals" className="text-accent-text underline">Back to evals</Link>}>
        {error?.message}
      </EmptyState>
    );
  }

  const { eval: ev, results } = data;
  const cfg = ev.config;
  const scored = cfg.scorer !== "none";
  const bests = {
    score: best(stats, (s) => s.avgScore, false),
    cost: best(stats, (s) => (s.done ? s.totalCost : null), true),
    latency: best(stats, (s) => s.avgLatencyMs, true),
    ttft: best(stats, (s) => s.avgTtftMs, true),
    speed: best(stats, (s) => s.tokensPerSec, false),
  };
  const win = (set: Set<string>, model: string) => (set.has(model) ? "font-semibold text-ok" : "");
  const cell = (rowIndex: number, model: string) => results.find((r) => r.rowIndex === rowIndex && r.model === model);
  const totalCost = stats.reduce((a, s) => a + s.totalCost + s.judgeCost, 0);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="border-b border-line px-6 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/evals" aria-label="Back to evals" className="rounded-md p-1 text-muted hover:bg-hover hover:text-fg">
            <ArrowLeft className="size-4" />
          </Link>
          <h1 className="min-w-0 truncate text-base font-semibold tracking-tight">{ev.name}</h1>
          <Badge tone={STATUS_TONE[ev.status]}>{ev.status}</Badge>
          <span className="tabular text-xs text-muted">
            {ev.done} of {ev.total} answers · {cfg.rows.length} row{cfg.rows.length === 1 ? "" : "s"} × {cfg.models.length} model{cfg.models.length === 1 ? "" : "s"} · {usd(totalCost)} total
          </span>
          <div className="ml-auto flex gap-2">
            {running ? (
              <Button variant="danger" icon={<Square className="size-3.5" />} onClick={() => void api.post(`/api/evals/${id}`, { action: "cancel" }).then(reload)}>
                Cancel
              </Button>
            ) : (
              <Button
                variant="ghost"
                aria-label="Delete eval"
                icon={<Trash2 className="size-3.5" />}
                onClick={async () => {
                  if (!window.confirm("Delete this eval and its results?")) return;
                  await api.del(`/api/evals/${id}`);
                  router.push("/evals");
                }}
              />
            )}
          </div>
        </div>
        {running ? (
          <div role="progressbar" aria-label="Eval progress" aria-valuenow={ev.done} aria-valuemin={0} aria-valuemax={ev.total} className="mt-3 h-1.5 overflow-hidden rounded-full bg-subtle">
            <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${ev.total ? (ev.done / ev.total) * 100 : 0}%` }} />
          </div>
        ) : null}
        {ev.error ? <Notice tone="err" className="mt-3">{ev.error}</Notice> : null}
      </header>

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-6 py-5">
        <section aria-labelledby="summary-heading">
          <h2 id="summary-heading" className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">Comparison</h2>
          <Card className="overflow-x-auto">
            <table className="tabular w-full text-left text-xs">
              <thead className="text-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">Model</th>
                  {scored ? <th className="px-3 py-2 text-right font-medium">Quality</th> : null}
                  {["Cost", "Avg latency", "p95 latency", "First token", "Tokens/s", "Tokens in → out", "Errors"].map((h) => (
                    <th key={h} className="px-3 py-2 text-right font-medium whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {stats.map((s) => (
                  <tr key={s.model} className="border-t border-line">
                    <td className="max-w-64 truncate px-3 py-2 font-mono">{s.model}</td>
                    {scored ? (
                      <td className={cx("px-3 py-2 text-right", win(bests.score, s.model))}>
                        {scoreText(s.avgScore)}
                        {s.scored < s.done - s.errors ? <span className="font-normal text-faint"> ({s.scored} scored)</span> : null}
                      </td>
                    ) : null}
                    <td className={cx("px-3 py-2 text-right", win(bests.cost, s.model))}>{s.done ? usd(s.totalCost) : "—"}</td>
                    <td className={cx("px-3 py-2 text-right", win(bests.latency, s.model))}>{duration(s.avgLatencyMs)}</td>
                    <td className="px-3 py-2 text-right">{duration(s.p95LatencyMs)}</td>
                    <td className={cx("px-3 py-2 text-right", win(bests.ttft, s.model))}>{duration(s.avgTtftMs)}</td>
                    <td className={cx("px-3 py-2 text-right", win(bests.speed, s.model))}>{s.tokensPerSec !== null ? Math.round(s.tokensPerSec) : "—"}</td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">{tokens(s.promptTokens)} → {tokens(s.completionTokens)}</td>
                    <td className={cx("px-3 py-2 text-right", s.errors > 0 && "text-err")}>{s.errors}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          <p className="mt-1.5 text-xs text-faint">
            Best value per column in green. {scored ? `Quality: ${SCORERS.find((s) => s.id === cfg.scorer)?.label}${cfg.scorer === "judge" ? ` by ${cfg.judgeModel} (judge cost is included in the total)` : ""}.` : ""}
          </p>
        </section>

        <section aria-labelledby="rows-heading">
          <h2 id="rows-heading" className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">Answers</h2>
          <div className="overflow-x-auto rounded-lg border border-line bg-panel">
            <table className="w-full table-fixed text-left text-xs">
              <thead className="text-muted">
                <tr>
                  <th className="w-56 px-3 py-2 font-medium">Input</th>
                  {cfg.models.map((m) => (
                    <th key={m} className="min-w-48 truncate px-3 py-2 font-mono font-medium">{m}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {cfg.rows.map((row, i) => (
                  <tr key={i} className="border-t border-line align-top">
                    <td className="px-3 py-2">
                      <p className="line-clamp-4 whitespace-pre-wrap">{row.input}</p>
                      {row.expected !== undefined ? <p className="mt-1 truncate text-faint">expected: {row.expected}</p> : null}
                    </td>
                    {cfg.models.map((m) => {
                      const r = cell(i, m);
                      if (!r) return <td key={m} className="px-3 py-2 text-faint">{running ? <Spinner className="size-3" /> : "not run"}</td>;
                      return (
                        <td key={m} className="p-0">
                          <button type="button" onClick={() => setOpen(r)} className="block w-full px-3 py-2 text-left hover:bg-subtle focus-visible:outline-offset-[-2px]">
                            <span className={cx("line-clamp-4 whitespace-pre-wrap", r.error && "text-err")}>{r.error ?? r.output}</span>
                            <span className="tabular mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-faint">
                              <ScoreBadge result={r} />
                              <span>{duration(r.latencyMs)}</span>
                              <span>{usd(r.cost)}</span>
                            </span>
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <Dialog open={open !== null} onClose={() => setOpen(null)} wide title={open ? open.model : ""}>
        {open ? (
          <div className="space-y-4">
            <div>
              <h3 className="mb-1 text-xs font-medium text-muted">Input</h3>
              <p className="rounded-md bg-subtle px-3 py-2 text-[13px] whitespace-pre-wrap">{cfg.rows[open.rowIndex]?.input}</p>
              {cfg.rows[open.rowIndex]?.expected !== undefined ? <p className="mt-1 text-xs text-muted">Expected: {cfg.rows[open.rowIndex].expected}</p> : null}
            </div>
            <div>
              <h3 className="mb-1 text-xs font-medium text-muted">Answer</h3>
              {open.error ? <Notice tone="err">{open.error}</Notice> : <Markdown text={open.output ?? ""} />}
            </div>
            {open.score !== null || open.scoreDetail ? (
              <div>
                <h3 className="mb-1 text-xs font-medium text-muted">Score</h3>
                <p className="flex flex-wrap items-center gap-2 text-[13px]">
                  <ScoreBadge result={open} />
                  <span>{open.scoreDetail}</span>
                </p>
              </div>
            ) : null}
            <p className="tabular flex flex-wrap gap-x-3 text-xs text-faint">
              <span>{duration(open.latencyMs)}</span>
              <span>first token {duration(open.ttftMs)}</span>
              <span>{tokens(open.promptTokens)} in → {tokens(open.completionTokens)} out</span>
              <span>{usd(open.cost)}</span>
              {open.judgeCost !== null ? <span>judge {usd(open.judgeCost)}</span> : null}
              {open.modelUsed && open.modelUsed !== open.model ? <span>answered by {open.modelUsed}</span> : null}
            </p>
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}

/* ---------- list ---------- */

function EvalsList() {
  const router = useRouter();
  const { data, loading } = useResource<{ evals: EvalSummary[] }>("/api/evals", { pollMs: 4000 });
  const evals = data?.evals ?? [];
  return (
    <>
      <PageHeader
        title="Evals"
        description="Run one prompt or a dataset across several models and compare quality, cost and latency."
        actions={
          <Button variant="primary" icon={<Plus className="size-3.5" />} onClick={() => router.push("/evals?id=new")}>
            New eval
          </Button>
        }
      />
      {loading ? (
        <div className="flex flex-1 items-center justify-center"><Spinner /></div>
      ) : evals.length === 0 ? (
        <EmptyState title="No evals yet" action={<Button variant="primary" onClick={() => router.push("/evals?id=new")}>Run your first eval</Button>}>
          Pick a few models, give them the same prompt, and see which is best for the price.
        </EmptyState>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full text-left text-[13px]">
            <thead className="sticky top-0 bg-bg text-xs text-muted shadow-[0_1px_0_var(--line)]">
              <tr>
                <th className="py-2 pr-2 pl-6 font-medium">Status</th>
                <th className="px-2 py-2 font-medium">Name</th>
                <th className="px-2 py-2 font-medium">Models</th>
                <th className="px-2 py-2 text-right font-medium">Progress</th>
                <th className="py-2 pr-6 pl-2 text-right font-medium">Started</th>
              </tr>
            </thead>
            <tbody>
              {evals.map((e) => (
                <tr
                  key={e.id}
                  tabIndex={0}
                  onClick={() => router.push(`/evals?id=${e.id}`)}
                  onKeyDown={(ev) => ev.key === "Enter" && router.push(`/evals?id=${e.id}`)}
                  className="cursor-pointer border-b border-line outline-offset-[-2px] hover:bg-subtle"
                >
                  <td className="py-2 pr-2 pl-6"><Badge tone={STATUS_TONE[e.status]}>{e.status}</Badge></td>
                  <td className="max-w-xs truncate px-2 py-2 font-medium">{e.name}</td>
                  <td className="max-w-md truncate px-2 py-2 font-mono text-xs text-muted">{e.config.models.join(", ")}</td>
                  <td className="tabular px-2 py-2 text-right">{e.done}/{e.total}</td>
                  <td className="py-2 pr-6 pl-2 text-right whitespace-nowrap text-muted">{timeAgo(e.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export function EvalsPage() {
  const router = useRouter();
  const id = useSearchParams().get("id");
  if (id === "new") {
    return (
      <>
        <PageHeader title="New eval" description="Every model gets the same inputs and settings, so the comparison is fair." />
        <NewEval onStarted={(evalId) => router.push(`/evals?id=${evalId}`)} onCancel={() => router.push("/evals")} />
      </>
    );
  }
  return id ? <EvalView key={id} id={id} /> : <EvalsList />;
}
