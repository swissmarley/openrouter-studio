"use client";

import { useRef, useState } from "react";
import { Download, Upload } from "lucide-react";
import { api, ApiClientError, useResource } from "@/lib/client/api";
import type { ImportReport } from "@/lib/shared/bundle";
import { usd } from "@/lib/shared/format";
import type { Settings } from "@/lib/shared/settings";
import { NumberField } from "../chat/settings-panel";
import { ModelPicker } from "../model-picker";
import { RequireKey } from "../session";
import { Button, Card, Chip, Field, Notice, PageHeader, Spinner, Switch } from "../ui";
import { KeyCard } from "./key-card";

interface BudgetStatus {
  windows: { period: "daily" | "monthly"; limitUsd: number; spentUsd: number; ratio: number; exceeded: boolean }[];
}

const THRESHOLDS = [0.5, 0.8, 0.9, 1];

function Preferences() {
  const { data, loading, setData } = useResource<{ settings: Settings; budget: BudgetStatus }>("/api/settings");
  const [draft, setDraft] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  if (loading || !data) return <Spinner />;
  const settings = draft ?? data.settings;
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(data.settings);
  const update = (patch: Partial<Settings>) => {
    setMessage(null);
    setDraft({ ...settings, ...patch });
  };
  const budgets = settings.budgets;
  const setBudgets = (patch: Partial<Settings["budgets"]>) => update({ budgets: { ...budgets, ...patch } });

  async function save() {
    setSaving(true);
    try {
      const res = await api.put<{ settings: Settings; budget: BudgetStatus }>("/api/settings", settings);
      setData(res);
      setDraft(null);
      setMessage({ tone: "ok", text: "Settings saved." });
    } catch (err) {
      const fields = err instanceof ApiClientError ? (err.details as { fieldErrors?: Record<string, string[]> } | undefined)?.fieldErrors : undefined;
      setMessage({ tone: "err", text: (fields ? Object.values(fields).flat()[0] : undefined) ?? (err instanceof ApiClientError ? err.message : "Could not save.") });
    } finally {
      setSaving(false);
    }
  }

  const spent = (period: "daily" | "monthly") => data.budget.windows.find((w) => w.period === period);

  return (
    <form
      className="space-y-6"
      // Values are validated on the server; native step/min checks would block valid amounts such as 1.
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <Card className="p-4">
        <h2 className="text-sm font-semibold">Budgets and alerts</h2>
        <p className="mt-1 text-xs text-muted">
          Caps on what this app spends with your key, measured from its own request log (UTC days and calendar months). For a hard limit that also covers other apps, set a credit
          limit on the key at openrouter.ai.
        </p>
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <NumberField label="Daily budget (USD)" min={0.01} step={0.5} placeholder="no cap" value={budgets.dailyUsd} onChange={(v) => setBudgets({ dailyUsd: v && v > 0 ? v : null })} />
            {spent("daily") ? <p className="tabular mt-1 text-xs text-faint">{usd(spent("daily")!.spentUsd)} spent today</p> : null}
          </div>
          <div>
            <NumberField label="Monthly budget (USD)" min={0.01} step={1} placeholder="no cap" value={budgets.monthlyUsd} onChange={(v) => setBudgets({ monthlyUsd: v && v > 0 ? v : null })} />
            {spent("monthly") ? <p className="tabular mt-1 text-xs text-faint">{usd(spent("monthly")!.spentUsd)} spent this month</p> : null}
          </div>
        </div>
        <Field label="Alert me at" className="mt-4">
          <div className="flex flex-wrap gap-1.5">
            {THRESHOLDS.map((t) => (
              <Chip
                key={t}
                active={budgets.alertThresholds.includes(t)}
                onClick={() => setBudgets({ alertThresholds: budgets.alertThresholds.includes(t) ? budgets.alertThresholds.filter((x) => x !== t) : [...budgets.alertThresholds, t].sort((a, b) => a - b) })}
              >
                {Math.round(t * 100)}%
              </Chip>
            ))}
          </div>
        </Field>
        <div className="mt-4">
          <Switch checked={budgets.hardStop} onChange={(hardStop) => setBudgets({ hardStop })} label="Block new model calls when a budget is spent (otherwise alert only)" />
        </div>
      </Card>

      <Card className="p-4">
        <h2 className="text-sm font-semibold">Default models</h2>
        <p className="mt-1 text-xs text-muted">Used when you open a new chat, create an agent, or pick an LLM judge.</p>
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Chat">
            <ModelPicker ariaLabel="Default chat model" value={settings.defaults.chatModel} onChange={(chatModel) => update({ defaults: { ...settings.defaults, chatModel } })} />
          </Field>
          <Field label="Agents">
            <ModelPicker ariaLabel="Default agent model" value={settings.defaults.agentModel} onChange={(agentModel) => update({ defaults: { ...settings.defaults, agentModel } })} />
          </Field>
          <Field label="Eval judge">
            <ModelPicker ariaLabel="Default judge model" value={settings.defaults.judgeModel} onChange={(judgeModel) => update({ defaults: { ...settings.defaults, judgeModel } })} />
          </Field>
        </div>
      </Card>

      <Card className="p-4">
        <h2 className="text-sm font-semibold">Tool safety</h2>
        <div className="mt-3 max-w-xs">
          <NumberField
            label="Tool calls per minute (all agents)"
            min={1}
            max={10000}
            step={10}
            value={settings.tools.rateLimitPerMin}
            onChange={(v) => update({ tools: { rateLimitPerMin: Math.max(1, Math.min(10000, Math.round(v ?? 60))) } })}
          />
        </div>
        <p className="mt-2 text-xs text-muted">Calls over the limit are refused and the agent is told to slow down or finish.</p>
      </Card>

      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" loading={saving} disabled={!dirty}>
          Save settings
        </Button>
        {dirty ? <Button onClick={() => setDraft(null)}>Discard changes</Button> : null}
        {message ? <span role="status" className={message.tone === "ok" ? "text-xs text-ok" : "text-xs text-err"}>{message.text}</span> : null}
      </div>
    </form>
  );
}

function ImportExport() {
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function importFile(f: File) {
    setBusy(true);
    setError(null);
    setReport(null);
    try {
      let bundle: unknown;
      try {
        bundle = JSON.parse(await f.text());
      } catch {
        throw new Error("That file is not valid JSON.");
      }
      const res = await api.post<{ report: ImportReport }>("/api/agents/import", bundle);
      setReport(res.report);
    } catch (err) {
      setError(err instanceof ApiClientError && err.code === "invalid_input" ? "That file is not an OpenRouter Studio agent export." : (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-4">
      <h2 className="text-sm font-semibold">Import and export agents</h2>
      <p className="mt-1 text-xs text-muted">
        Agents are exported as one JSON file with the custom tools they use. MCP credentials are never included. Importing adds to what you have; nothing is overwritten.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <a href="/api/agents/export" download className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line bg-panel px-3 text-[13px] font-medium hover:bg-hover">
          <Download className="size-3.5" /> Export all agents
        </a>
        <input
          ref={file}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void importFile(f);
            e.target.value = "";
          }}
        />
        <Button icon={<Upload className="size-3.5" />} loading={busy} onClick={() => file.current?.click()}>
          Import from file
        </Button>
      </div>
      {error ? <Notice tone="err" className="mt-3">{error}</Notice> : null}
      {report ? (
        <Notice tone={report.warnings.length ? "warn" : "ok"} className="mt-3">
          <p>
            Imported {report.agents.length} agent{report.agents.length === 1 ? "" : "s"}
            {report.agents.length ? `: ${report.agents.join(", ")}` : ""}
            {report.customTools.length ? `, plus ${report.customTools.length} custom tool${report.customTools.length === 1 ? "" : "s"}` : ""}.
          </p>
          {report.warnings.length ? (
            <ul className="mt-1 list-disc pl-5">
              {report.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          ) : null}
        </Notice>
      ) : null}
    </Card>
  );
}

export function SettingsPage() {
  return (
    <>
      <PageHeader title="Settings" description="Your key, budgets, default models and agent import/export." />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl space-y-6 px-6 py-6">
          <KeyCard />
          {/* The key card above already prompts for a key, so the rest just stays hidden without one. */}
          <RequireKey fallback={null}>
            <Preferences />
            <ImportExport />
          </RequireKey>
        </div>
      </div>
    </>
  );
}
