"use client";

import { useMemo, useState } from "react";
import { Pencil, Play, Plug, Plus, RefreshCw, Trash2 } from "lucide-react";
import { api, ApiClientError, useResource } from "@/lib/client/api";
import { BUILTIN_TOOLS, type CustomTool, type CustomToolInput, type McpServer, type McpServerInput } from "@/lib/shared/agents";
import { cx, dateTime, duration } from "@/lib/shared/format";
import { parseToolSchema } from "@/lib/shared/zod-source";
import { Badge, Button, Card, Dialog, EmptyState, Field, Input, Notice, PageHeader, Select, Spinner, Switch, Tabs, Textarea } from "../ui";

type Tab = "builtin" | "custom" | "mcp" | "log";

interface TestResult {
  status: string;
  durationMs: number;
  result: unknown;
}

const SAMPLE_ARGS: Record<string, string> = {
  web_fetch: '{\n  "url": "https://openrouter.ai/docs/quickstart.md",\n  "maxChars": 600\n}',
  http_request: '{\n  "method": "GET",\n  "url": "https://openrouter.ai/api/v1/models/count"\n}',
  run_javascript: '{\n  "code": "const xs = [3, 1, 2]; xs.sort((a, b) => a - b)"\n}',
  file_read: '{\n  "path": "notes.md"\n}',
  file_list: "{}",
  file_write: '{\n  "path": "notes.md",\n  "content": "hello from the tools page\\n"\n}',
};

function pretty(value: unknown): string {
  try {
    return typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** Runs one tool call by hand and shows what the model would get back. */
function TryTool({ body, initialArgs }: { body: (args: unknown) => unknown; initialArgs: string }) {
  const [args, setArgs] = useState(initialArgs);
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<TestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setError(null);
    setOut(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(args || "{}");
    } catch (err) {
      return setError(`Arguments are not valid JSON: ${(err as Error).message}`);
    }
    setBusy(true);
    try {
      setOut(await api.post<TestResult>("/api/tools/test", body(parsed)));
    } catch (err) {
      const details = err instanceof ApiClientError && err.details ? `\n${pretty(err.details)}` : "";
      setError(`${err instanceof ApiClientError ? err.message : "The test failed."}${details}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <Field label="Arguments (JSON)">
        <Textarea rows={4} spellCheck={false} className="font-mono text-xs" value={args} onChange={(e) => setArgs(e.target.value)} />
      </Field>
      <Button size="sm" icon={<Play className="size-3.5" />} loading={busy} onClick={() => void run()}>
        Run tool
      </Button>
      {error ? <Notice tone="err" className="whitespace-pre-wrap">{error}</Notice> : null}
      {out ? (
        <div>
          <p className="mb-1 flex items-center gap-2 text-xs text-muted">
            <Badge tone={out.status === "ok" ? "ok" : "err"}>{out.status.replace("_", " ")}</Badge>
            <span className="tabular">{duration(out.durationMs)}</span>
          </p>
          <pre className="max-h-64 overflow-auto rounded-md border border-line bg-subtle p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">{pretty(out.result)}</pre>
        </div>
      ) : null}
    </div>
  );
}

function BuiltinTab() {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      {BUILTIN_TOOLS.map((t) => (
        <li key={t.id}>
          <Card className="p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 text-[13px] font-semibold">
                  {t.label}
                  <span className="font-mono text-[11px] font-normal text-muted">{t.id}</span>
                  {t.sensitive ? <Badge tone="warn">asks for approval by default</Badge> : null}
                </p>
                <p className="mt-1 text-xs text-muted">{t.description}</p>
              </div>
              <Button size="sm" aria-expanded={open === t.id} onClick={() => setOpen(open === t.id ? null : t.id)}>
                {open === t.id ? "Close" : "Try it"}
              </Button>
            </div>
            {open === t.id ? (
              <div className="mt-3 border-t border-line pt-3">
                <TryTool initialArgs={SAMPLE_ARGS[t.id] ?? "{}"} body={(args) => ({ kind: "builtin", name: t.id, args })} />
              </div>
            ) : null}
          </Card>
        </li>
      ))}
    </ul>
  );
}

const NEW_TOOL: CustomToolInput = {
  name: "",
  description: "",
  schemaSource: 'z.object({\n  text: z.string().describe("Text to analyze"),\n})',
  code: "// `input` matches the schema above. Return any JSON-serializable value.\nconst words = input.text.trim().split(/\\s+/).filter(Boolean);\nreturn { words: words.length, characters: input.text.length };",
  requireApproval: false,
  allowNetwork: false,
  timeoutMs: 5000,
};

function CustomToolDialog({ tool, onClose, onSaved }: { tool: CustomTool | "new"; onClose: () => void; onSaved: () => void }) {
  const [draft, setDraft] = useState<CustomToolInput>(() =>
    tool === "new"
      ? NEW_TOOL
      : { name: tool.name, description: tool.description, schemaSource: tool.schemaSource, code: tool.code, requireApproval: tool.requireApproval, allowNetwork: tool.allowNetwork, timeoutMs: tool.timeoutMs },
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The same parser the server uses, so mistakes show as you type. It never evaluates the text.
  const schema = useMemo(() => {
    try {
      return { json: parseToolSchema(draft.schemaSource).jsonSchema, error: null };
    } catch (err) {
      return { json: null, error: (err as Error).message };
    }
  }, [draft.schemaSource]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      if (tool === "new") await api.post("/api/tools/custom", draft);
      else await api.put(`/api/tools/custom/${tool.id}`, draft);
      onSaved();
      onClose();
    } catch (err) {
      const fields = err instanceof ApiClientError ? (err.details as { fieldErrors?: Record<string, string[]> } | undefined)?.fieldErrors : undefined;
      const first = fields ? Object.values(fields).flat()[0] : undefined;
      setError(first ?? (err instanceof ApiClientError ? err.message : "Could not save the tool."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      wide="xl"
      title={tool === "new" ? "New custom tool" : `Edit ${tool.name}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={saving} disabled={!draft.name || !draft.description || schema.error !== null} onClick={() => void save()}>
            Save tool
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <div className="space-y-3">
          <Field label="Name" hint="what the model calls">
            <Input placeholder="word_count" className="font-mono" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </Field>
          <Field label="Description" hint="the model decides when to use the tool from this">
            <Textarea rows={2} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
          </Field>
          <Field label="Input schema (Zod)" error={schema.error}>
            <Textarea rows={7} spellCheck={false} className="font-mono text-xs" value={draft.schemaSource} onChange={(e) => setDraft({ ...draft, schemaSource: e.target.value })} aria-invalid={schema.error ? true : undefined} />
          </Field>
          <Field label="Function body (JavaScript)" hint="runs in the sandbox">
            <Textarea rows={9} spellCheck={false} className="font-mono text-xs" value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value })} />
          </Field>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <Switch checked={draft.requireApproval} onChange={(requireApproval) => setDraft({ ...draft, requireApproval })} label="Ask for approval by default" />
            <Switch checked={draft.allowNetwork} onChange={(allowNetwork) => setDraft({ ...draft, allowNetwork })} label="Allow fetch()" />
            <label className="flex items-center gap-1.5 text-xs text-muted">
              Timeout (ms)
              <Input type="number" min={100} max={30000} step={500} className="w-24" value={draft.timeoutMs} onChange={(e) => setDraft({ ...draft, timeoutMs: Math.max(100, Math.min(30000, Number(e.target.value) || 5000)) })} />
            </label>
          </div>
          {error ? <Notice tone="err">{error}</Notice> : null}
        </div>
        <div className="space-y-4">
          <div>
            <h3 className="mb-1 text-xs font-medium text-muted">What the model sees (JSON Schema)</h3>
            <pre className="max-h-56 overflow-auto rounded-md border border-line bg-subtle p-2 font-mono text-[11px] leading-relaxed">
              {schema.json ? pretty(schema.json) : "Fix the schema to see its JSON Schema."}
            </pre>
          </div>
          <div>
            <h3 className="mb-1 text-xs font-medium text-muted">Test this draft</h3>
            <TryTool initialArgs={'{\n  "text": "the quick brown fox"\n}'} body={(args) => ({ kind: "custom", tool: draft, args })} />
          </div>
          <p className="text-xs text-faint">
            The schema is parsed, not executed, and the function runs in an isolated WebAssembly sandbox with no access to this server. With fetch() allowed, requests
            to private addresses are blocked.
          </p>
        </div>
      </div>
    </Dialog>
  );
}

function CustomTab() {
  const { data, loading, reload } = useResource<{ tools: CustomTool[] }>("/api/tools/custom");
  const [editing, setEditing] = useState<CustomTool | "new" | null>(null);
  const tools = data?.tools ?? [];
  if (loading) return <Spinner />;
  return (
    <>
      <div className="mb-3 flex justify-end">
        <Button variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setEditing("new")}>
          New tool
        </Button>
      </div>
      {tools.length === 0 ? (
        <EmptyState title="No custom tools yet">Define a tool with a Zod schema for its input and a JavaScript function for its behavior.</EmptyState>
      ) : (
        <ul className="space-y-2">
          {tools.map((t) => (
            <li key={t.id}>
              <Card className="flex items-start gap-3 p-3">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 font-mono text-[13px] font-semibold">
                    {t.name}
                    {t.requireApproval ? <Badge tone="warn">asks for approval</Badge> : null}
                    {t.allowNetwork ? <Badge>network</Badge> : null}
                  </p>
                  <p className="mt-0.5 text-xs text-muted">{t.description}</p>
                </div>
                <Button size="sm" icon={<Pencil className="size-3.5" />} onClick={() => setEditing(t)}>
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Delete ${t.name}`}
                  icon={<Trash2 className="size-3.5" />}
                  onClick={async () => {
                    if (!window.confirm(`Delete the tool "${t.name}"? Agents that use it will run without it.`)) return;
                    await api.del(`/api/tools/custom/${t.id}`);
                    await reload();
                  }}
                />
              </Card>
            </li>
          ))}
        </ul>
      )}
      {editing ? <CustomToolDialog tool={editing} onClose={() => setEditing(null)} onSaved={() => void reload()} /> : null}
    </>
  );
}

function McpDialog({ server, onClose, onSaved }: { server: McpServer | "new"; onClose: () => void; onSaved: () => void }) {
  const existing = server === "new" ? null : server;
  const [draft, setDraft] = useState<McpServerInput>({
    name: existing?.name ?? "",
    url: existing?.url ?? "",
    authKind: existing?.authKind ?? "none",
    requireApproval: existing?.requireApproval ?? true,
    enabled: existing?.enabled ?? true,
  });
  const [token, setToken] = useState("");
  const [headers, setHeaders] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setError(null);
    const body: McpServerInput = { ...draft };
    if (draft.authKind === "bearer" && token) body.token = token;
    if (draft.authKind === "headers" && headers.trim()) {
      try {
        const parsed = JSON.parse(headers);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("expected an object");
        body.headers = parsed;
      } catch (err) {
        return setError(`Headers must be a JSON object of name/value pairs (${(err as Error).message}).`);
      }
    }
    setSaving(true);
    try {
      if (existing) await api.put(`/api/mcp/${existing.id}`, body);
      else await api.post("/api/mcp", body);
      onSaved();
      onClose();
    } catch (err) {
      const fields = err instanceof ApiClientError ? (err.details as { fieldErrors?: Record<string, string[]> } | undefined)?.fieldErrors : undefined;
      setError((fields ? Object.values(fields).flat()[0] : undefined) ?? (err instanceof ApiClientError ? err.message : "Could not save the server."));
    } finally {
      setSaving(false);
    }
  }

  const keeps = existing?.hasCredentials && existing.authKind === draft.authKind;
  return (
    <Dialog
      open
      onClose={onClose}
      title={existing ? `Edit ${existing.name}` : "Connect an MCP server"}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={saving} disabled={!draft.name || !draft.url} onClick={() => void save()}>
            Save server
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Name">
          <Input placeholder="linear" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </Field>
        <Field label="URL" hint="Streamable HTTP or SSE">
          <Input type="url" placeholder="https://mcp.example.com/mcp" value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} />
        </Field>
        <Field label="Authentication">
          <Select value={draft.authKind} onChange={(e) => setDraft({ ...draft, authKind: e.target.value as McpServerInput["authKind"] })}>
            <option value="none">None</option>
            <option value="bearer">Bearer token</option>
            <option value="headers">Custom headers</option>
          </Select>
        </Field>
        {draft.authKind === "bearer" ? (
          <Field label="Token" hint={keeps ? "leave blank to keep the stored token" : undefined}>
            <Input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />
          </Field>
        ) : null}
        {draft.authKind === "headers" ? (
          <Field label="Headers (JSON)" hint={keeps ? "leave blank to keep the stored headers" : undefined}>
            <Textarea rows={3} spellCheck={false} className="font-mono text-xs" placeholder='{ "X-API-Key": "…" }' value={headers} onChange={(e) => setHeaders(e.target.value)} />
          </Field>
        ) : null}
        <Switch checked={draft.requireApproval} onChange={(requireApproval) => setDraft({ ...draft, requireApproval })} label="Ask for approval before its tools run (default for new agents)" />
        <Switch checked={draft.enabled} onChange={(enabled) => setDraft({ ...draft, enabled })} label="Enabled" />
        {error ? <Notice tone="err">{error}</Notice> : null}
        <p className="text-xs text-faint">Credentials are encrypted on the server and never shown again.</p>
      </div>
    </Dialog>
  );
}

function McpTab() {
  const { data, loading, reload, setData } = useResource<{ servers: McpServer[] }>("/api/mcp");
  const [editing, setEditing] = useState<McpServer | "new" | null>(null);
  const [probing, setProbing] = useState<string | null>(null);
  const servers = data?.servers ?? [];

  async function probe(id: string) {
    setProbing(id);
    try {
      const res = await api.post<{ server: McpServer }>(`/api/mcp/${id}/probe`);
      setData({ servers: servers.map((s) => (s.id === id ? res.server : s)) });
    } finally {
      setProbing(null);
    }
  }

  if (loading) return <Spinner />;
  return (
    <>
      <div className="mb-3 flex justify-end">
        <Button variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setEditing("new")}>
          Connect server
        </Button>
      </div>
      {servers.length === 0 ? (
        <EmptyState title="No MCP servers connected">Connect a remote Model Context Protocol server and its tools become available to your agents.</EmptyState>
      ) : (
        <ul className="space-y-2">
          {servers.map((s) => (
            <li key={s.id}>
              <Card className="p-3">
                <div className="flex flex-wrap items-start gap-3">
                  <Plug className="mt-0.5 size-4 text-muted" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 text-[13px] font-semibold">
                      {s.name}
                      {!s.enabled ? <Badge>disabled</Badge> : null}
                      {s.authKind !== "none" ? <Badge tone={s.hasCredentials ? "neutral" : "warn"}>{s.hasCredentials ? s.authKind : "credentials missing"}</Badge> : null}
                      {s.requireApproval ? <Badge tone="warn">asks for approval</Badge> : null}
                    </p>
                    <p className="truncate font-mono text-[11px] text-muted">{s.url}</p>
                    {s.lastStatus ? <p className={cx("mt-1 text-xs", s.lastStatus.startsWith("Failed") ? "text-err" : "text-ok")}>{s.lastStatus}</p> : null}
                  </div>
                  <Button size="sm" icon={<RefreshCw className="size-3.5" />} loading={probing === s.id} onClick={() => void probe(s.id)}>
                    Connect &amp; list tools
                  </Button>
                  <Button size="sm" icon={<Pencil className="size-3.5" />} onClick={() => setEditing(s)}>
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Remove ${s.name}`}
                    icon={<Trash2 className="size-3.5" />}
                    onClick={async () => {
                      if (!window.confirm(`Remove the MCP server "${s.name}"?`)) return;
                      await api.del(`/api/mcp/${s.id}`);
                      await reload();
                    }}
                  />
                </div>
                {s.tools?.length ? (
                  <ul className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 border-t border-line pt-3 sm:grid-cols-2">
                    {s.tools.map((t) => (
                      <li key={t.name} className="min-w-0 text-xs">
                        <span className="font-mono font-medium">{t.name}</span>
                        {t.description ? <span className="text-muted"> — {t.description}</span> : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </Card>
            </li>
          ))}
        </ul>
      )}
      {editing ? <McpDialog server={editing} onClose={() => setEditing(null)} onSaved={() => void reload()} /> : null}
    </>
  );
}

interface ToolCallRow {
  id: string;
  runId: string | null;
  agentName: string | null;
  toolName: string;
  source: string;
  args: string;
  result: string | null;
  status: string;
  approval: string;
  durationMs: number | null;
  ts: number;
}

function LogTab() {
  const { data, loading } = useResource<{ calls: ToolCallRow[] }>("/api/tools/calls?limit=200", { pollMs: 5000 });
  const [open, setOpen] = useState<ToolCallRow | null>(null);
  const calls = data?.calls ?? [];
  if (loading) return <Spinner />;
  if (calls.length === 0) return <EmptyState title="No tool calls yet">Every tool call, from an agent or from this page, is recorded here.</EmptyState>;
  return (
    <>
      <div className="overflow-x-auto rounded-md border border-line">
        <table className="w-full text-left text-xs">
          <thead className="bg-subtle text-muted">
            <tr>
              {["When", "Tool", "Source", "Status", "Approval", "Duration", "Agent", "Arguments"].map((h) => (
                <th key={h} className="px-2.5 py-1.5 font-medium whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {calls.map((c) => (
              <tr key={c.id} tabIndex={0} onClick={() => setOpen(c)} onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    setOpen(c);
                  }
                }} className="cursor-pointer border-t border-line outline-offset-[-2px] hover:bg-subtle">
                <td className="tabular px-2.5 py-1.5 whitespace-nowrap text-muted">{dateTime(c.ts)}</td>
                <td className="px-2.5 py-1.5 font-mono font-medium">{c.toolName}</td>
                <td className="px-2.5 py-1.5 text-muted">{c.source}</td>
                <td className="px-2.5 py-1.5">
                  <Badge tone={c.status === "ok" ? "ok" : c.status === "error" || c.status === "timeout" ? "err" : "warn"}>{c.status.replace("_", " ")}</Badge>
                </td>
                <td className="px-2.5 py-1.5 text-muted">{c.approval}</td>
                <td className="tabular px-2.5 py-1.5 text-right">{duration(c.durationMs)}</td>
                <td className="px-2.5 py-1.5 whitespace-nowrap text-muted">{c.agentName ?? "—"}</td>
                <td className="max-w-xs truncate px-2.5 py-1.5 font-mono text-muted">{c.args}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Dialog open={open !== null} onClose={() => setOpen(null)} wide title={open ? `${open.toolName} · ${dateTime(open.ts)}` : ""}>
        {open ? (
          <div className="space-y-3">
            <div>
              <h3 className="mb-1 text-xs font-medium text-muted">Arguments</h3>
              <pre className="max-h-60 overflow-auto rounded-md border border-line bg-subtle p-2 font-mono text-[11px] whitespace-pre-wrap">{open.args}</pre>
            </div>
            <div>
              <h3 className="mb-1 text-xs font-medium text-muted">Result (first 4,000 characters)</h3>
              <pre className="max-h-60 overflow-auto rounded-md border border-line bg-subtle p-2 font-mono text-[11px] whitespace-pre-wrap">{open.result ?? ""}</pre>
            </div>
            {open.runId ? (
              <a href={`/runs?id=${open.runId}`} className="text-xs text-accent-text underline">
                Open the run this call belongs to
              </a>
            ) : null}
          </div>
        ) : null}
      </Dialog>
    </>
  );
}

export function ToolsPage() {
  const [tab, setTab] = useState<Tab>("builtin");
  return (
    <>
      <PageHeader title="Tools" description="What agents can do: built-in tools, your own Zod + JavaScript tools, and MCP servers. Every call is rate limited and logged." />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "builtin", label: "Built-in" },
          { id: "custom", label: "Custom" },
          { id: "mcp", label: "MCP servers" },
          { id: "log", label: "Call log" },
        ]}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        {tab === "builtin" ? <BuiltinTab /> : tab === "custom" ? <CustomTab /> : tab === "mcp" ? <McpTab /> : <LogTab />}
      </div>
    </>
  );
}
