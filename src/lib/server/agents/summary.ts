import "server-only";
import type { schema } from "@/db";
import type { RunStatus, RunSummary } from "@/lib/shared/runs";

export function toRunSummary(row: typeof schema.runs.$inferSelect): RunSummary {
  return {
    id: row.id,
    agentId: row.agentId,
    agentName: row.agentName,
    input: row.input,
    status: row.status as RunStatus,
    output: row.output,
    error: row.error,
    stopReason: row.stopReason,
    replayOf: row.replayOf,
    steps: row.steps,
    promptTokens: row.promptTokens,
    completionTokens: row.completionTokens,
    cost: row.cost,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
  };
}
