import "server-only";
import { parseToolSchema } from "@/lib/shared/zod-source";
import { safeFetch } from "./net";
import { runSandboxed } from "./sandbox";
import type { ToolSpec } from "./types";

export interface CustomToolRow {
  name: string;
  description: string;
  schemaSource: string;
  code: string;
  allowNetwork: boolean;
  timeoutMs: number;
}

/**
 * A user-defined tool: a Zod schema (parsed from source, never evaluated) plus a JS
 * function body that runs in the sandbox. Network access, if granted, goes through the
 * same SSRF-guarded fetch as the built-in web tools.
 */
export function customToolSpec(row: CustomToolRow): ToolSpec {
  const { schema } = parseToolSchema(row.schemaSource);
  return {
    name: row.name,
    description: row.description,
    source: "custom",
    inputSchema: schema,
    // The sandbox enforces the deadline itself; the outer guard is a backstop.
    timeoutMs: row.timeoutMs + 2000,
    async run(args, ctx) {
      const out = await runSandboxed(row.code, {
        mode: "function",
        input: args,
        timeoutMs: row.timeoutMs,
        signal: ctx.signal,
        fetch: row.allowNetwork
          ? async (url, init) => {
              const res = await safeFetch(url, { ...init, signal: ctx.signal, maxBytes: 500_000 });
              return { status: res.status, headers: res.headers, body: res.body };
            }
          : undefined,
      });
      if (!out.ok) {
        const logs = out.logs.length ? `\nconsole output:\n${out.logs.join("\n").slice(0, 2000)}` : "";
        throw new Error(`${out.error}${logs}`);
      }
      return out.logs.length ? { result: out.result, logs: out.logs } : out.result;
    },
  };
}
