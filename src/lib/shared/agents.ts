import { z } from "zod";
import { REASONING_EFFORTS } from "./chat";
import { routingSchema } from "./routing";

/** Agent definitions, shared by the builder UI, the API and the run harness. */

export interface BuiltinToolInfo {
  id: string;
  label: string;
  description: string;
  /** Sensitive tools default to requiring human approval. */
  sensitive: boolean;
}

export const BUILTIN_TOOLS: BuiltinToolInfo[] = [
  { id: "web_fetch", label: "Web fetch", description: "GET a public web page or API and return its text.", sensitive: false },
  { id: "http_request", label: "HTTP request", description: "Any HTTP method with headers and a body. Can change remote state.", sensitive: true },
  { id: "run_javascript", label: "Code sandbox", description: "Run JavaScript in an isolated WebAssembly sandbox with no network or file access.", sensitive: false },
  { id: "file_read", label: "File read", description: "Read a text file from the agent workspace.", sensitive: false },
  { id: "file_list", label: "File list", description: "List files in the agent workspace.", sensitive: false },
  { id: "file_write", label: "File write", description: "Create or overwrite a file in the agent workspace.", sensitive: true },
];

/** `builtin:<id>`, `custom:<toolId>`, or `mcp:<serverId>` (every tool that server offers). */
export const toolRefSchema = z.string().regex(/^(builtin|custom|mcp):[\w-]{1,80}$/, "Invalid tool reference.");

export const agentConfigSchema = z.object({
  model: z.string().trim().min(1).max(200),
  instructions: z.string().max(100_000).default(""),
  tools: z.array(toolRefSchema).max(60).default([]),
  /** Tool refs that pause the run for a human decision before each call. */
  requireApproval: z.array(toolRefSchema).max(60).default([]),
  /** Loop bound, enforced with the SDK's stepCountIs stop condition. */
  maxSteps: z.number().int().min(1).max(50).default(8),
  /** Spend cap for one run in USD (sub-agents included). null = no cap. */
  budgetUsd: z.number().positive().max(1000).nullable().default(0.25),
  temperature: z.number().min(0).max(2).nullable().default(null),
  maxOutputTokens: z.number().int().min(1).max(1_000_000).nullable().default(null),
  reasoningEffort: z.enum(REASONING_EFFORTS).nullable().default(null),
  routing: routingSchema.prefault({}),
  /** Agents this one can call as a tool and get an answer back from. */
  subAgents: z.array(z.string().min(1).max(80)).max(8).default([]),
  /** Agents this one can hand the whole conversation over to. */
  handoffs: z.array(z.string().min(1).max(80)).max(8).default([]),
});
export type AgentConfig = z.infer<typeof agentConfigSchema>;

export const agentInputSchema = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(500).default(""),
  config: agentConfigSchema,
});
export type AgentInput = z.infer<typeof agentInputSchema>;

export interface Agent extends AgentInput {
  id: string;
  createdAt: number;
  updatedAt: number;
}

/** Stable, tool-name-safe identifier derived from an agent's name. */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return slug || "agent";
}

export const customToolInputSchema = z.object({
  name: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_]{1,48}$/, "Use lowercase letters, digits and underscores, starting with a letter (2-49 characters)."),
  description: z.string().trim().min(1, "Describe what the tool does; the model relies on this.").max(1000),
  /** Zod source text, e.g. z.object({ city: z.string() }). Parsed, never evaluated. */
  schemaSource: z.string().min(1).max(20_000),
  /** Body of `async (input) => { … }`, run in the sandbox. */
  code: z.string().min(1).max(50_000),
  requireApproval: z.boolean().default(false),
  /** Give the sandboxed code a guarded `fetch`. */
  allowNetwork: z.boolean().default(false),
  timeoutMs: z.number().int().min(100).max(30_000).default(5000),
});
export type CustomToolInput = z.infer<typeof customToolInputSchema>;

export interface CustomTool extends CustomToolInput {
  id: string;
  createdAt: number;
  updatedAt: number;
}

export const mcpServerInputSchema = z.object({
  name: z.string().trim().regex(/^[\w-]{1,40}$/, "Use letters, digits, - and _ (up to 40 characters)."),
  url: z.string().trim().url().regex(/^https?:\/\//, "MCP servers must be http(s) URLs."),
  authKind: z.enum(["none", "bearer", "headers"]).default("none"),
  /** Write-only: never returned by the API. Omit on update to keep the stored value. */
  token: z.string().max(4000).optional(),
  headers: z.record(z.string().max(200), z.string().max(4000)).optional(),
  requireApproval: z.boolean().default(true),
  enabled: z.boolean().default(true),
});
export type McpServerInput = z.infer<typeof mcpServerInputSchema>;

export interface McpServer {
  id: string;
  name: string;
  url: string;
  authKind: "none" | "bearer" | "headers";
  hasCredentials: boolean;
  requireApproval: boolean;
  enabled: boolean;
  tools: { name: string; description?: string }[] | null;
  lastStatus: string | null;
}
