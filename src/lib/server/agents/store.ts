import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import {
  agentConfigSchema,
  type Agent,
  type AgentInput,
  type CustomTool,
  type CustomToolInput,
  type McpServer,
  type McpServerInput,
} from "@/lib/shared/agents";
import { BUNDLE_FORMAT, type Bundle, type ImportReport } from "@/lib/shared/bundle";
import { parseToolSchema, ZodSourceError } from "@/lib/shared/zod-source";
import { ApiError } from "../api";
import { encrypt, newId } from "../crypto";

/* ---------- agents ---------- */

function toAgent(row: typeof schema.agents.$inferSelect): Agent {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    // Stored configs are re-parsed so agents saved by an older build pick up new defaults.
    config: agentConfigSchema.parse(row.config),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function listAgents(accountId: string): Agent[] {
  return getDb().select().from(schema.agents).where(eq(schema.agents.accountId, accountId)).orderBy(desc(schema.agents.updatedAt)).all().map(toAgent);
}

export function getAgent(accountId: string, id: string): Agent {
  const row = getDb().select().from(schema.agents).where(and(eq(schema.agents.id, id), eq(schema.agents.accountId, accountId))).get();
  if (!row) throw new ApiError(404, "not_found", "Agent not found.");
  return toAgent(row);
}

/** An agent may not delegate or hand off to itself, and may only reference this account's agents. */
function checkAgentRefs(accountId: string, selfId: string | null, input: AgentInput) {
  const known = new Set(listAgents(accountId).map((a) => a.id));
  for (const id of [...input.config.subAgents, ...input.config.handoffs]) {
    if (id === selfId) throw new ApiError(400, "invalid_input", "An agent cannot delegate or hand off to itself.");
    if (!known.has(id)) throw new ApiError(400, "invalid_input", "A referenced agent no longer exists.");
  }
}

export function createAgent(accountId: string, input: AgentInput): Agent {
  checkAgentRefs(accountId, null, input);
  const id = newId("agt");
  getDb().insert(schema.agents).values({ id, accountId, name: input.name, description: input.description, config: input.config }).run();
  return getAgent(accountId, id);
}

export function updateAgent(accountId: string, id: string, input: AgentInput): Agent {
  getAgent(accountId, id);
  checkAgentRefs(accountId, id, input);
  getDb()
    .update(schema.agents)
    .set({ name: input.name, description: input.description, config: input.config, updatedAt: Date.now() })
    .where(and(eq(schema.agents.id, id), eq(schema.agents.accountId, accountId)))
    .run();
  return getAgent(accountId, id);
}

export function deleteAgent(accountId: string, id: string) {
  getAgent(accountId, id);
  const db = getDb();
  db.delete(schema.agents).where(and(eq(schema.agents.id, id), eq(schema.agents.accountId, accountId))).run();
  // Drop dangling references so other agents stay valid.
  for (const other of listAgents(accountId)) {
    const { subAgents, handoffs } = other.config;
    if (subAgents.includes(id) || handoffs.includes(id)) {
      const config = { ...other.config, subAgents: subAgents.filter((x) => x !== id), handoffs: handoffs.filter((x) => x !== id) };
      db.update(schema.agents).set({ config }).where(eq(schema.agents.id, other.id)).run();
    }
  }
}

/* ---------- custom tools ---------- */

const toCustomTool = (row: typeof schema.customTools.$inferSelect): CustomTool => ({
  id: row.id,
  name: row.name,
  description: row.description,
  schemaSource: row.schemaSource,
  code: row.code,
  requireApproval: row.requireApproval,
  allowNetwork: row.allowNetwork,
  timeoutMs: row.timeoutMs,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export function listCustomTools(accountId: string): CustomTool[] {
  return getDb().select().from(schema.customTools).where(eq(schema.customTools.accountId, accountId)).orderBy(schema.customTools.name).all().map(toCustomTool);
}

export function getCustomTool(accountId: string, id: string): CustomTool {
  const row = getDb().select().from(schema.customTools).where(and(eq(schema.customTools.id, id), eq(schema.customTools.accountId, accountId))).get();
  if (!row) throw new ApiError(404, "not_found", "Tool not found.");
  return toCustomTool(row);
}

const RESERVED = /^(web_fetch|http_request|run_javascript|file_read|file_write|file_list|task)$|^(ask_|handoff_to_)/;

function checkCustomTool(accountId: string, selfId: string | null, input: CustomToolInput) {
  if (RESERVED.test(input.name)) throw new ApiError(400, "invalid_input", `"${input.name}" is reserved for a built-in tool. Pick another name.`);
  try {
    parseToolSchema(input.schemaSource);
  } catch (err) {
    if (err instanceof ZodSourceError) throw new ApiError(400, "invalid_schema", err.message);
    throw err;
  }
  const clash = listCustomTools(accountId).find((t) => t.name === input.name && t.id !== selfId);
  if (clash) throw new ApiError(409, "duplicate", `You already have a tool named "${input.name}".`);
}

export function createCustomTool(accountId: string, input: CustomToolInput): CustomTool {
  checkCustomTool(accountId, null, input);
  const id = newId("tool");
  getDb().insert(schema.customTools).values({ id, accountId, ...input }).run();
  return getCustomTool(accountId, id);
}

export function updateCustomTool(accountId: string, id: string, input: CustomToolInput): CustomTool {
  getCustomTool(accountId, id);
  checkCustomTool(accountId, id, input);
  getDb().update(schema.customTools).set({ ...input, updatedAt: Date.now() }).where(and(eq(schema.customTools.id, id), eq(schema.customTools.accountId, accountId))).run();
  return getCustomTool(accountId, id);
}

export function deleteCustomTool(accountId: string, id: string) {
  getCustomTool(accountId, id);
  getDb().delete(schema.customTools).where(and(eq(schema.customTools.id, id), eq(schema.customTools.accountId, accountId))).run();
}

/* ---------- MCP servers ---------- */

// Credentials are write-only: the API reports whether they exist, never what they are.
const toMcpServer = (row: typeof schema.mcpServers.$inferSelect): McpServer => ({
  id: row.id,
  name: row.name,
  url: row.url,
  authKind: row.authKind,
  hasCredentials: row.authEnc !== null,
  requireApproval: row.requireApproval,
  enabled: row.enabled,
  tools: row.toolsCache ?? null,
  lastStatus: row.lastStatus,
});

export function listMcpServers(accountId: string): McpServer[] {
  return getDb().select().from(schema.mcpServers).where(eq(schema.mcpServers.accountId, accountId)).orderBy(schema.mcpServers.name).all().map(toMcpServer);
}

export function getMcpRow(accountId: string, id: string) {
  const row = getDb().select().from(schema.mcpServers).where(and(eq(schema.mcpServers.id, id), eq(schema.mcpServers.accountId, accountId))).get();
  if (!row) throw new ApiError(404, "not_found", "MCP server not found.");
  return row;
}

function sealAuth(input: McpServerInput): string | null | undefined {
  if (input.authKind === "none") return null;
  if (input.authKind === "bearer" && input.token) return encrypt(JSON.stringify({ token: input.token }));
  if (input.authKind === "headers" && input.headers && Object.keys(input.headers).length) return encrypt(JSON.stringify({ headers: input.headers }));
  return undefined; // nothing new supplied: keep what is stored
}

export function createMcpServer(accountId: string, input: McpServerInput): McpServer {
  if (listMcpServers(accountId).some((s) => s.name === input.name)) throw new ApiError(409, "duplicate", `You already have an MCP server named "${input.name}".`);
  const id = newId("mcp");
  getDb()
    .insert(schema.mcpServers)
    .values({ id, accountId, name: input.name, url: input.url, authKind: input.authKind, authEnc: sealAuth(input) ?? null, requireApproval: input.requireApproval, enabled: input.enabled })
    .run();
  return toMcpServer(getMcpRow(accountId, id));
}

export function updateMcpServer(accountId: string, id: string, input: McpServerInput): McpServer {
  const existing = getMcpRow(accountId, id);
  if (listMcpServers(accountId).some((s) => s.name === input.name && s.id !== id)) throw new ApiError(409, "duplicate", `You already have an MCP server named "${input.name}".`);
  const sealed = sealAuth(input);
  // Changing the auth scheme without supplying a secret must not reuse the old one.
  const authEnc = sealed !== undefined ? sealed : input.authKind === existing.authKind ? existing.authEnc : null;
  getDb()
    .update(schema.mcpServers)
    .set({ name: input.name, url: input.url, authKind: input.authKind, authEnc, requireApproval: input.requireApproval, enabled: input.enabled, updatedAt: Date.now() })
    .where(eq(schema.mcpServers.id, id))
    .run();
  return toMcpServer(getMcpRow(accountId, id));
}

export function deleteMcpServer(accountId: string, id: string) {
  getMcpRow(accountId, id);
  getDb().delete(schema.mcpServers).where(eq(schema.mcpServers.id, id)).run();
}

export function recordMcpProbe(id: string, tools: { name: string; description?: string }[] | null, status: string) {
  getDb().update(schema.mcpServers).set({ ...(tools ? { toolsCache: tools } : {}), lastStatus: status, updatedAt: Date.now() }).where(eq(schema.mcpServers.id, id)).run();
}

/* ---------- import / export ---------- */

export function exportBundle(accountId: string, agentIds?: string[]): Bundle {
  const all = listAgents(accountId);
  const agents = agentIds ? all.filter((a) => agentIds.includes(a.id)) : all;
  if (agents.length === 0) throw new ApiError(400, "nothing_to_export", "There are no agents to export.");
  const tools = listCustomTools(accountId);
  const servers = listMcpServers(accountId);
  const agentName = new Map(all.map((a) => [a.id, a.name]));
  const usedTools = new Set<string>();
  const usedServers = new Set<string>();

  const portableRef = (ref: string): string | null => {
    if (ref.startsWith("custom:")) {
      const tool = tools.find((t) => t.id === ref.slice(7));
      if (!tool) return null;
      usedTools.add(tool.id);
      return `custom:${tool.name}`;
    }
    if (ref.startsWith("mcp:")) {
      const server = servers.find((s) => s.id === ref.slice(4));
      if (!server) return null;
      usedServers.add(server.id);
      return `mcp:${server.name}`;
    }
    return ref;
  };
  const refs = (list: string[]) => list.map(portableRef).filter((r): r is string => r !== null);
  const names = (ids: string[]) => ids.map((id) => agentName.get(id)).filter((n): n is string => !!n);

  return {
    format: BUNDLE_FORMAT,
    version: 1,
    agents: agents.map((a) => ({
      name: a.name,
      description: a.description,
      config: { ...a.config, tools: refs(a.config.tools), requireApproval: refs(a.config.requireApproval), subAgents: names(a.config.subAgents), handoffs: names(a.config.handoffs) },
    })),
    customTools: tools
      .filter((t) => usedTools.has(t.id))
      .map(({ name, description, schemaSource, code, requireApproval, allowNetwork, timeoutMs }) => ({ name, description, schemaSource, code, requireApproval, allowNetwork, timeoutMs })),
    mcpServers: servers.filter((s) => usedServers.has(s.id)).map(({ name, url, authKind }) => ({ name, url, authKind })),
  };
}

/**
 * Imports a bundle. Nothing existing is overwritten: an agent whose name is taken is
 * imported under a numbered name, and an existing custom tool or MCP server with the
 * same name is reused as-is.
 */
export function importBundle(accountId: string, bundle: Bundle): ImportReport {
  const db = getDb();
  const report: ImportReport = { agents: [], customTools: [], mcpServers: [], warnings: [] };

  return db.transaction(() => {
    const toolIdByName = new Map(listCustomTools(accountId).map((t) => [t.name, t.id]));
    for (const tool of bundle.customTools) {
      if (toolIdByName.has(tool.name)) {
        report.warnings.push(`Kept your existing tool "${tool.name}" instead of importing another with that name.`);
        continue;
      }
      try {
        toolIdByName.set(tool.name, createCustomTool(accountId, tool).id);
        report.customTools.push(tool.name);
      } catch (err) {
        report.warnings.push(`Skipped tool "${tool.name}": ${(err as Error).message}`);
      }
    }

    const serverIdByName = new Map(listMcpServers(accountId).map((s) => [s.name, s.id]));
    for (const server of bundle.mcpServers) {
      if (serverIdByName.has(server.name)) continue;
      serverIdByName.set(server.name, createMcpServer(accountId, { ...server, requireApproval: true, enabled: true }).id);
      report.mcpServers.push(server.name);
      if (server.authKind !== "none") report.warnings.push(`MCP server "${server.name}" was imported without credentials. Add them under Tools.`);
    }

    // Pass 1: create every agent without cross-references, so pass 2 can resolve names in any order.
    const existingNames = new Set(listAgents(accountId).map((a) => a.name));
    const idByBundleName = new Map<string, string>();
    for (const agent of bundle.agents) {
      let name = agent.name;
      for (let i = 2; existingNames.has(name); i++) name = `${agent.name} (${i})`.slice(0, 60);
      existingNames.add(name);
      const id = newId("agt");
      db.insert(schema.agents).values({ id, accountId, name, description: agent.description, config: { ...agent.config, tools: [], requireApproval: [], subAgents: [], handoffs: [] } }).run();
      idByBundleName.set(agent.name, id);
      report.agents.push(name);
    }

    const existingIdByName = new Map(listAgents(accountId).map((a) => [a.name, a.id]));
    for (const agent of bundle.agents) {
      const id = idByBundleName.get(agent.name)!;
      const toolRef = (ref: string): string | null => {
        const [kind, name] = [ref.slice(0, ref.indexOf(":")), ref.slice(ref.indexOf(":") + 1)];
        if (kind === "builtin") return ref;
        const target = kind === "custom" ? toolIdByName.get(name) : serverIdByName.get(name);
        if (!target) {
          report.warnings.push(`"${agent.name}" refers to ${kind === "custom" ? "tool" : "MCP server"} "${name}", which is not in the file or your account.`);
          return null;
        }
        return `${kind}:${target}`;
      };
      const agentRef = (name: string): string | null => {
        const target = idByBundleName.get(name) ?? existingIdByName.get(name);
        if (!target || target === id) {
          report.warnings.push(`"${agent.name}" refers to agent "${name}", which could not be found.`);
          return null;
        }
        return target;
      };
      const keep = <T,>(list: (T | null)[]) => list.filter((x): x is T => x !== null);
      const config = agentConfigSchema.parse({
        ...agent.config,
        tools: keep(agent.config.tools.map(toolRef)),
        requireApproval: keep(agent.config.requireApproval.map(toolRef)),
        subAgents: keep(agent.config.subAgents.map(agentRef)),
        handoffs: keep(agent.config.handoffs.map(agentRef)),
      });
      db.update(schema.agents).set({ config }).where(eq(schema.agents.id, id)).run();
    }
    report.warnings = [...new Set(report.warnings)];
    return report;
  });
}
