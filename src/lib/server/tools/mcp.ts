import "server-only";
import type { Tool } from "@openrouter/agent";
import { createMCPTools } from "@openrouter/agent/mcp";
import { decrypt } from "../crypto";

export interface McpServerRow {
  id: string;
  name: string;
  url: string;
  authKind: "none" | "bearer" | "headers";
  authEnc: string | null;
}

export interface McpConnection {
  tools: Tool[];
  close(): Promise<void>;
}

const CONNECT_TIMEOUT_MS = 15_000;

function authOf(row: McpServerRow) {
  if (row.authKind === "none" || !row.authEnc) return undefined;
  const secret = JSON.parse(decrypt(row.authEnc)) as { token?: string; headers?: Record<string, string> };
  if (row.authKind === "bearer" && secret.token) return { kind: "bearer" as const, token: secret.token };
  if (row.authKind === "headers" && secret.headers) return { kind: "headers" as const, headers: secret.headers };
  return undefined;
}

/**
 * Connects to a remote MCP server (Streamable HTTP or SSE) via the Agent SDK and returns
 * its tools as SDK tools. The URL is one the user configured themselves, so local and
 * private addresses are allowed here, unlike URLs chosen by a model.
 */
export async function connectMcp(row: McpServerRow, signal?: AbortSignal): Promise<McpConnection> {
  const timeout = AbortSignal.timeout(CONNECT_TIMEOUT_MS);
  try {
    const handle = await createMCPTools({
      url: row.url,
      auth: authOf(row),
      clientInfo: { name: "openrouter-studio", version: "1.0.0" },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    return { tools: [...handle.tools], close: () => handle.close().catch(() => {}) };
  } catch (err) {
    const reason = timeout.aborted ? `no response within ${CONNECT_TIMEOUT_MS / 1000}s` : (err as Error).message;
    throw new Error(`Could not connect to MCP server "${row.name}": ${reason}`);
  }
}

export function describeTools(tools: Tool[]): { name: string; description?: string }[] {
  return tools.map((t) => {
    const fn = (t as { function?: { name?: string; description?: string } }).function;
    return { name: fn?.name ?? "unknown", description: fn?.description };
  });
}
