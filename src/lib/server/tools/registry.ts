import "server-only";
import type { Tool } from "@openrouter/agent";
import { and, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { BUILTIN_SPECS } from "./builtin";
import { customToolSpec } from "./custom";
import { guardSdkTool, toSdkTool } from "./guard";
import { connectMcp } from "./mcp";
import type { ToolHost, ToolSpec } from "./types";

export interface ResolvedTools {
  tools: Tool[];
  /** name -> where it came from, for labeling tool calls in the trace. */
  sources: Map<string, "builtin" | "custom" | "mcp">;
  /** Names of tools that pause for human approval before each call. */
  approvalNames: Set<string>;
  /** Things worth telling the user (a missing tool, an unreachable server). */
  warnings: string[];
  close(): Promise<void>;
}

/**
 * Turns an agent's tool references into guarded SDK tools. A reference that cannot be
 * resolved (deleted tool, MCP server down) becomes a warning instead of failing the run:
 * the agent proceeds with the tools that are available.
 */
export async function resolveTools(refs: string[], approvalRefs: string[], host: ToolHost): Promise<ResolvedTools> {
  const db = getDb();
  const tools: Tool[] = [];
  const sources = new Map<string, "builtin" | "custom" | "mcp">();
  const warnings: string[] = [];
  const closers: (() => Promise<void>)[] = [];
  const needsApproval = new Set(approvalRefs);
  const approvalNames = new Set<string>();

  const add = (spec: ToolSpec, ref: string) => {
    if (sources.has(spec.name)) {
      warnings.push(`Two tools are named "${spec.name}"; only the first is available.`);
      return;
    }
    sources.set(spec.name, spec.source as "builtin" | "custom");
    if (needsApproval.has(ref)) approvalNames.add(spec.name);
    tools.push(toSdkTool(spec, host, needsApproval.has(ref)));
  };

  const customIds = refs.filter((r) => r.startsWith("custom:")).map((r) => r.slice(7));
  const customRows = customIds.length
    ? db.select().from(schema.customTools).where(and(eq(schema.customTools.accountId, host.accountId), inArray(schema.customTools.id, customIds))).all()
    : [];
  const mcpIds = refs.filter((r) => r.startsWith("mcp:")).map((r) => r.slice(4));
  const mcpRows = mcpIds.length
    ? db.select().from(schema.mcpServers).where(and(eq(schema.mcpServers.accountId, host.accountId), inArray(schema.mcpServers.id, mcpIds))).all()
    : [];

  for (const ref of refs) {
    const [kind, id] = [ref.slice(0, ref.indexOf(":")), ref.slice(ref.indexOf(":") + 1)];
    if (kind === "builtin") {
      const spec = BUILTIN_SPECS[id];
      if (spec) add(spec, ref);
      else warnings.push(`Unknown built-in tool "${id}".`);
    } else if (kind === "custom") {
      const row = customRows.find((r) => r.id === id);
      if (!row) {
        warnings.push("A custom tool this agent uses has been deleted.");
        continue;
      }
      try {
        add(customToolSpec(row), ref);
      } catch (err) {
        warnings.push(`Custom tool "${row.name}" has an invalid schema: ${(err as Error).message}`);
      }
    } else if (kind === "mcp") {
      const row = mcpRows.find((r) => r.id === id);
      if (!row) {
        warnings.push("An MCP server this agent uses has been removed.");
        continue;
      }
      if (!row.enabled) {
        warnings.push(`MCP server "${row.name}" is disabled.`);
        continue;
      }
      try {
        const conn = await connectMcp(row, host.signal);
        closers.push(conn.close);
        for (const t of conn.tools) {
          const name = (t as { function: { name: string } }).function.name;
          if (sources.has(name)) {
            warnings.push(`MCP tool "${name}" from "${row.name}" clashes with another tool and was skipped.`);
            continue;
          }
          sources.set(name, "mcp");
          if (needsApproval.has(ref)) approvalNames.add(name);
          tools.push(guardSdkTool(t, "mcp", host, needsApproval.has(ref)));
        }
      } catch (err) {
        warnings.push((err as Error).message);
      }
    }
  }

  return { tools, sources, approvalNames, warnings, close: async () => void (await Promise.allSettled(closers.map((c) => c()))) };
}
