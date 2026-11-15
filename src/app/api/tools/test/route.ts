import { z } from "zod";
import { ApiError, parseBody, route } from "@/lib/server/api";
import { requireAccount } from "@/lib/server/session";
import { BUILTIN_SPECS } from "@/lib/server/tools/builtin";
import { customToolSpec } from "@/lib/server/tools/custom";
import { guarded } from "@/lib/server/tools/guard";
import type { ToolHost, ToolSpec } from "@/lib/server/tools/types";
import { customToolInputSchema } from "@/lib/shared/agents";
import { ZodSourceError } from "@/lib/shared/zod-source";

const bodySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("builtin"), name: z.string().max(80), args: z.unknown() }),
  // An unsaved draft, so a tool can be tried before it is saved.
  z.object({ kind: z.literal("custom"), tool: customToolInputSchema, args: z.unknown() }),
]);

/**
 * Runs one tool call by hand from the Tools page. It goes through the same guard as an
 * agent's call: validated arguments, rate limit, deadline, and an audit-log row.
 */
export const POST = route(async (req) => {
  const account = await requireAccount();
  const body = await parseBody(req, bodySchema);

  let spec: ToolSpec;
  if (body.kind === "builtin") {
    const found = BUILTIN_SPECS[body.name];
    if (!found) throw new ApiError(404, "not_found", "Unknown built-in tool.");
    spec = found;
  } else {
    try {
      spec = customToolSpec(body.tool);
    } catch (err) {
      if (err instanceof ZodSourceError) throw new ApiError(400, "invalid_schema", err.message);
      throw err;
    }
  }

  const parsed = spec.inputSchema.safeParse(body.args ?? {});
  if (!parsed.success) {
    throw new ApiError(400, "invalid_args", "The arguments do not match the tool's schema.", z.flattenError(parsed.error));
  }

  const abort = new AbortController();
  req.signal.addEventListener("abort", () => abort.abort(), { once: true });
  let status = "ok";
  let durationMs = 0;
  const host: ToolHost = {
    accountId: account.id,
    runId: null,
    agent: "manual test",
    depth: 0,
    signal: abort.signal,
    emit: (e) => {
      if (e.type === "tool.result") {
        status = e.status;
        durationMs = e.durationMs;
      }
    },
    waitIfPaused: async () => {},
    wasApproved: () => false,
  };
  const callId = `test_${Date.now()}`;
  const result = await guarded(host, {
    name: spec.name,
    source: spec.source,
    timeoutMs: spec.timeoutMs,
    args: parsed.data,
    callId,
    execute: (signal) => spec.run(parsed.data, { accountId: account.id, runId: null, signal, callId }),
  });
  return { status, durationMs, result };
});
