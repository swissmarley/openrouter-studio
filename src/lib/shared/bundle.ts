import { z } from "zod";
import { agentConfigSchema, customToolInputSchema } from "./agents";

/**
 * Portable export format for agents. References are by *name* (agents, custom tools,
 * MCP servers) so a bundle can be imported into another account. MCP credentials are
 * never included.
 */
export const BUNDLE_FORMAT = "openrouter-studio/agents";

const bundleAgentConfig = agentConfigSchema.extend({
  // `builtin:<id>`, `custom:<tool name>` or `mcp:<server name>`
  tools: z.array(z.string().regex(/^(builtin|custom|mcp):[\w-]{1,80}$/)).max(60).default([]),
  requireApproval: z.array(z.string().regex(/^(builtin|custom|mcp):[\w-]{1,80}$/)).max(60).default([]),
  // agent names
  subAgents: z.array(z.string().min(1).max(60)).max(8).default([]),
  handoffs: z.array(z.string().min(1).max(60)).max(8).default([]),
});

export const bundleSchema = z.object({
  format: z.literal(BUNDLE_FORMAT),
  version: z.literal(1),
  customTools: z.array(customToolInputSchema).max(100).default([]),
  mcpServers: z
    .array(z.object({ name: z.string().regex(/^[\w-]{1,40}$/), url: z.string().url(), authKind: z.enum(["none", "bearer", "headers"]).default("none") }))
    .max(50)
    .default([]),
  agents: z
    .array(z.object({ name: z.string().trim().min(1).max(60), description: z.string().max(500).default(""), config: bundleAgentConfig }))
    .min(1)
    .max(100),
});

export type Bundle = z.infer<typeof bundleSchema>;

export interface ImportReport {
  agents: string[];
  customTools: string[];
  mcpServers: string[];
  warnings: string[];
}
