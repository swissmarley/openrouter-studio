"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Bot, Download, Play, Plus, Save, Sparkles, Trash2 } from "lucide-react";
import { api, ApiClientError, useResource } from "@/lib/client/api";
import { BUILTIN_TOOLS, type Agent, type AgentConfig, type AgentInput, type CustomTool, type McpServer } from "@/lib/shared/agents";
import { REASONING_EFFORTS } from "@/lib/shared/chat";
import { cx } from "@/lib/shared/format";
import { countRouting, defaultRouting } from "@/lib/shared/routing";
import type { Settings } from "@/lib/shared/settings";
import { NumberField, Section } from "../chat/settings-panel";
import { ModelPicker } from "../model-picker";
import { RoutingControls } from "../routing-controls";
import { Badge, Button, Chip, EmptyState, Field, Input, Notice, PageHeader, Select, Spinner, Textarea } from "../ui";

const blankConfig = (model: string): AgentConfig => ({
  model,
  instructions: "",
  tools: [],
  requireApproval: [],
  maxSteps: 8,
  budgetUsd: 0.25,
  temperature: null,
  maxOutputTokens: null,
  reasoningEffort: null,
  routing: defaultRouting,
  subAgents: [],
  handoffs: [],
});

interface ToolOption {
  ref: string;
  label: string;
  description: string;
  sensitive: boolean;
  group: "Built-in" | "Custom" | "MCP servers";
}

function ToolChecklist({
  options,
  config,
  onChange,
}: {
  options: ToolOption[];
  config: AgentConfig;
  onChange: (patch: Pick<AgentConfig, "tools" | "requireApproval">) => void;
}) {
  const groups = ["Built-in", "Custom", "MCP servers"] as const;

  function toggleTool(option: ToolOption) {
    const on = config.tools.includes(option.ref);
    onChange({
      tools: on ? config.tools.filter((r) => r !== option.ref) : [...config.tools, option.ref],
      // Sensitive tools start out gated; turning a tool off also drops its gate.
      requireApproval: on ? config.requireApproval.filter((r) => r !== option.ref) : option.sensitive ? [...config.requireApproval, option.ref] : config.requireApproval,
    });
  }

  function toggleApproval(ref: string) {
    const on = config.requireApproval.includes(ref);
    onChange({ tools: config.tools, requireApproval: on ? config.requireApproval.filter((r) => r !== ref) : [...config.requireApproval, ref] });
  }

  return (
    <div className="space-y-3">
      {groups.map((group) => {
        const items = options.filter((o) => o.group === group);
        if (items.length === 0) return null;
        return (
          <fieldset key={group}>
            <legend className="mb-1 text-[11px] font-semibold tracking-wide text-faint uppercase">{group}</legend>
            <ul className="divide-y divide-line rounded-md border border-line">
              {items.map((o) => {
                const on = config.tools.includes(o.ref);
                return (
                  <li key={o.ref} className="flex items-start gap-2.5 px-3 py-2">
                    <input
                      id={`tool-${o.ref}`}
                      type="checkbox"
                      checked={on}
                      onChange={() => toggleTool(o)}
                      className="mt-0.5 size-3.5 accent-[var(--accent)]"
                    />
                    <label htmlFor={`tool-${o.ref}`} className="min-w-0 flex-1 cursor-pointer">
                      <span className="flex flex-wrap items-center gap-1.5 text-[13px] font-medium">
                        {o.label}
                        {o.sensitive ? <Badge tone="warn">sensitive</Badge> : null}
                      </span>
                      <span className="block text-xs text-muted">{o.description}</span>
                    </label>
                    {on ? (
                      <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-muted">
                        <input
                          type="checkbox"
                          checked={config.requireApproval.includes(o.ref)}
                          onChange={() => toggleApproval(o.ref)}
                          className="size-3.5 accent-[var(--accent)]"
                        />
                        Ask me first
                      </label>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </fieldset>
        );
      })}
    </div>
  );
}

function AgentEditor({
  agent,
  agents,
  toolOptions,
  defaultModel,
  onSaved,
  onDeleted,
}: {
  agent: Agent | null;
  agents: Agent[];
  toolOptions: ToolOption[];
  defaultModel: string;
  onSaved: (agent: Agent) => void;
  onDeleted: () => void;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<AgentInput>(() =>
    agent ? { name: agent.name, description: agent.description, config: agent.config } : { name: "", description: "", config: blankConfig(defaultModel) },
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [task, setTask] = useState("");
  const [starting, setStarting] = useState(false);

  const config = draft.config;
  const setConfig = (patch: Partial<AgentConfig>) => setDraft((d) => ({ ...d, config: { ...d.config, ...patch } }));
  const dirty = useMemo(
    () => !agent || JSON.stringify({ name: agent.name, description: agent.description, config: agent.config }) !== JSON.stringify(draft),
    [agent, draft],
  );
  const others = agents.filter((a) => a.id !== agent?.id);
  // A reference can outlive the tool it pointed to; show those so they can be removed.
  const missing = config.tools.filter((ref) => !toolOptions.some((o) => o.ref === ref));

  async function save(): Promise<Agent | null> {
    setSaving(true);
    setError(null);
    try {
      const res = agent ? await api.put<{ agent: Agent }>(`/api/agents/${agent.id}`, draft) : await api.post<{ agent: Agent }>("/api/agents", draft);
      setSavedAt(Date.now());
      onSaved(res.agent);
      return res.agent;
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not save the agent.");
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function run() {
    setStarting(true);
    setError(null);
    try {
      // Run what is on screen: unsaved edits are saved first.
      const target = dirty ? await save() : agent;
      if (!target) return;
      const res = await api.post<{ id: string }>("/api/runs", { agentId: target.id, input: task });
      router.push(`/runs?id=${res.id}`);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not start the run.");
    } finally {
      setStarting(false);
    }
  }

  async function remove() {
    if (!agent || !window.confirm(`Delete the agent "${agent.name}"? Its past runs are kept.`)) return;
    await api.del(`/api/agents/${agent.id}`);
    onDeleted();
  }

  const toggleRef = (key: "subAgents" | "handoffs", id: string) =>
    setConfig({ [key]: config[key].includes(id) ? config[key].filter((x) => x !== id) : [...config[key], id] });

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      // Values are validated on the server; native step/min checks would block valid amounts such as 0.25.
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-5 px-6 py-5">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Name">
              <Input required maxLength={60} placeholder="Researcher" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </Field>
            <Field label="Model" hint="needs tool calling to use tools">
              <ModelPicker value={config.model} onChange={(model) => setConfig({ model })} />
            </Field>
          </div>
          <Field label="Description" hint="shown to other agents that can call this one">
            <Input maxLength={500} placeholder="What this agent is good at" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
          </Field>
          <Field label="System prompt">
            <Textarea rows={8} placeholder="You are…" value={config.instructions} onChange={(e) => setConfig({ instructions: e.target.value })} />
          </Field>

          <div>
            <h2 className="mb-2 text-xs font-medium text-muted">Tools</h2>
            <ToolChecklist options={toolOptions} config={config} onChange={setConfig} />
            {missing.length ? (
              <Notice tone="warn" className="mt-2 flex items-center justify-between gap-3">
                <span>{missing.length} tool{missing.length === 1 ? "" : "s"} this agent used no longer exist{missing.length === 1 ? "s" : ""}.</span>
                <Button
                  size="sm"
                  onClick={() => setConfig({ tools: config.tools.filter((r) => !missing.includes(r)), requireApproval: config.requireApproval.filter((r) => !missing.includes(r)) })}
                >
                  Remove
                </Button>
              </Notice>
            ) : null}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Max steps" hint="tool-using model calls">
              <Input type="number" min={1} max={50} required value={config.maxSteps} onChange={(e) => setConfig({ maxSteps: Math.max(1, Math.min(50, Number(e.target.value) || 1)) })} />
            </Field>
            <NumberField label="Budget per run (USD)" min={0.001} step={0.05} placeholder="no cap" value={config.budgetUsd} onChange={(budgetUsd) => setConfig({ budgetUsd: budgetUsd && budgetUsd > 0 ? budgetUsd : null })} />
          </div>

          {others.length ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Sub-agents" hint="can be asked for an answer">
                <div className="flex flex-wrap gap-1.5">
                  {others.map((a) => (
                    <Chip key={a.id} active={config.subAgents.includes(a.id)} onClick={() => toggleRef("subAgents", a.id)}>
                      {a.name}
                    </Chip>
                  ))}
                </div>
              </Field>
              <Field label="Handoffs" hint="can take over the whole task">
                <div className="flex flex-wrap gap-1.5">
                  {others.map((a) => (
                    <Chip key={a.id} active={config.handoffs.includes(a.id)} onClick={() => toggleRef("handoffs", a.id)}>
                      {a.name}
                    </Chip>
                  ))}
                </div>
              </Field>
            </div>
          ) : null}

          <div className="rounded-md border border-line">
            <Section title="Sampling and reasoning">
              <div className="grid grid-cols-3 gap-2">
                <NumberField label="Temperature" min={0} max={2} step={0.1} value={config.temperature} onChange={(temperature) => setConfig({ temperature })} />
                <NumberField label="Max output tokens" min={1} step={256} value={config.maxOutputTokens} onChange={(maxOutputTokens) => setConfig({ maxOutputTokens })} />
                <Field label="Reasoning effort">
                  <Select value={config.reasoningEffort ?? ""} onChange={(e) => setConfig({ reasoningEffort: (e.target.value || null) as AgentConfig["reasoningEffort"] })}>
                    <option value="">Model default</option>
                    {REASONING_EFFORTS.map((e) => (
                      <option key={e} value={e}>{e}</option>
                    ))}
                  </Select>
                </Field>
              </div>
            </Section>
            <div className="[&>details]:border-b-0">
              <Section title="Routing" badge={countRouting(config.routing) ? <Badge tone="accent">{countRouting(config.routing)}</Badge> : null}>
                <RoutingControls model={config.model} value={config.routing} onChange={(routing) => setConfig({ routing })} />
              </Section>
            </div>
          </div>

          {error ? <Notice tone="err">{error}</Notice> : null}
        </div>
      </div>

      <div className="border-t border-line bg-panel px-6 py-3">
        <div className="mx-auto flex max-w-3xl flex-col gap-2">
          <div className="flex items-end gap-2">
            <Textarea
              aria-label="Task for this agent"
              rows={2}
              placeholder="Give the agent a task…  (⌘/Ctrl + Enter to run)"
              value={task}
              onChange={(e) => setTask(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && task.trim()) {
                  e.preventDefault();
                  void run();
                }
              }}
              className="flex-1 resize-none"
            />
            <Button variant="primary" icon={<Play className="size-3.5" />} loading={starting} disabled={!task.trim() || !draft.name.trim() || !config.model} onClick={() => void run()}>
              {dirty ? "Save & run" : "Run"}
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Button type="submit" icon={<Save className="size-3.5" />} loading={saving} disabled={!dirty || !draft.name.trim() || !config.model}>
              {agent ? "Save changes" : "Create agent"}
            </Button>
            {!dirty && savedAt ? <span className="text-xs text-ok">Saved</span> : null}
            {dirty && agent ? <span className="text-xs text-faint">Unsaved changes</span> : null}
            {agent ? (
              <Button variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => void remove()} className="ml-auto">
                Delete
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </form>
  );
}

export function AgentsPage() {
  const router = useRouter();
  const selected = useSearchParams().get("id");
  const agentsRes = useResource<{ agents: Agent[] }>("/api/agents");
  const toolsRes = useResource<{ tools: CustomTool[] }>("/api/tools/custom");
  const mcpRes = useResource<{ servers: McpServer[] }>("/api/mcp");
  const settingsRes = useResource<{ settings: Settings }>("/api/settings");
  const [installing, setInstalling] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const agents = useMemo(() => agentsRes.data?.agents ?? [], [agentsRes.data]);
  const defaultModel = settingsRes.data?.settings.defaults.agentModel ?? "";

  const toolOptions = useMemo<ToolOption[]>(
    () => [
      ...BUILTIN_TOOLS.map((t): ToolOption => ({ ref: `builtin:${t.id}`, label: t.label, description: t.description, sensitive: t.sensitive, group: "Built-in" })),
      ...(toolsRes.data?.tools ?? []).map((t): ToolOption => ({ ref: `custom:${t.id}`, label: t.name, description: t.description, sensitive: t.requireApproval, group: "Custom" })),
      ...(mcpRes.data?.servers ?? []).map((s): ToolOption => ({
        ref: `mcp:${s.id}`,
        label: s.name,
        description: s.tools ? `${s.tools.length} tool${s.tools.length === 1 ? "" : "s"}: ${s.tools.map((t) => t.name).join(", ") || "none"}` : `${s.url} (not connected yet)`,
        sensitive: s.requireApproval,
        group: "MCP servers",
      })),
    ],
    [toolsRes.data, mcpRes.data],
  );

  // Land on the first agent rather than an empty pane.
  useEffect(() => {
    if (!selected && agents.length > 0) router.replace(`/agents?id=${agents[0].id}`);
  }, [selected, agents, router]);

  async function installExamples() {
    setInstalling(true);
    try {
      const res = await api.post<{ report: { agents: string[]; warnings: string[] } }>("/api/agents/examples");
      setNotice(`Added ${res.report.agents.join(", ")}.`);
      await Promise.all([agentsRes.reload(), toolsRes.reload()]);
    } catch (err) {
      setNotice(err instanceof ApiClientError ? err.message : "Could not add the examples.");
    } finally {
      setInstalling(false);
    }
  }

  const current = selected && selected !== "new" ? agents.find((a) => a.id === selected) : null;
  const loading = agentsRes.loading || settingsRes.loading || toolsRes.loading || mcpRes.loading;

  return (
    <>
      <PageHeader
        title="Agents"
        description="A model, a system prompt, tools, a step limit and a budget. Runs are traced step by step."
        actions={
          <>
            <Button icon={<Sparkles className="size-3.5" />} loading={installing} onClick={() => void installExamples()}>
              Add examples
            </Button>
            {agents.length ? (
              // A file download from an API route, not a page navigation.
              <a href="/api/agents/export" download className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line bg-panel px-3 text-[13px] font-medium hover:bg-hover">
                <Download className="size-3.5" /> Export
              </a>
            ) : null}
            <Button variant="primary" icon={<Plus className="size-3.5" />} onClick={() => router.push("/agents?id=new")}>
              New agent
            </Button>
          </>
        }
      />
      {notice ? (
        <Notice className="mx-6 mt-3">{notice}</Notice>
      ) : null}
      {loading ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner />
        </div>
      ) : agents.length === 0 && selected !== "new" ? (
        <EmptyState
          title="No agents yet"
          action={
            <div className="flex gap-2">
              <Button variant="primary" loading={installing} onClick={() => void installExamples()}>Add the example agents</Button>
              <Button onClick={() => router.push("/agents?id=new")}>Start from scratch</Button>
            </div>
          }
        >
          The examples are a researcher, a coder and a data analyst, plus a concierge that hands off between them.
        </EmptyState>
      ) : (
        <div className="flex min-h-0 flex-1">
          <nav aria-label="Agents" className="hidden w-60 shrink-0 overflow-y-auto border-r border-line p-2 md:block">
            <ul className="space-y-0.5">
              {agents.map((a) => (
                <li key={a.id}>
                  <button
                    type="button"
                    aria-current={a.id === selected ? "true" : undefined}
                    onClick={() => router.push(`/agents?id=${a.id}`)}
                    className={cx("flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left", a.id === selected ? "bg-hover" : "hover:bg-hover")}
                  >
                    <Bot className="mt-0.5 size-3.5 shrink-0 text-muted" aria-hidden />
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] font-medium">{a.name}</span>
                      <span className="block truncate font-mono text-[11px] text-faint">{a.config.model}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </nav>
          {selected === "new" || current ? (
            <AgentEditor
              // Remount per agent so the form starts from that agent's saved state.
              key={current?.id ?? "new"}
              agent={current ?? null}
              agents={agents}
              toolOptions={toolOptions}
              defaultModel={defaultModel}
              onSaved={(saved) => {
                void agentsRes.reload();
                if (!current) router.replace(`/agents?id=${saved.id}`);
              }}
              onDeleted={() => {
                void agentsRes.reload();
                router.replace("/agents");
              }}
            />
          ) : (
            <EmptyState title="Pick an agent">Choose one on the left, or create a new one.</EmptyState>
          )}
        </div>
      )}
    </>
  );
}
