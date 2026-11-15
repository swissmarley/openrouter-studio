import "server-only";
import type { z } from "zod";
import type { RunEventData, ToolSource } from "@/lib/shared/runs";

/** What a tool implementation receives besides its (already validated) arguments. */
export interface ToolRunContext {
  accountId: string;
  runId: string | null;
  /** Fires when the run is cancelled or the tool's deadline passes. */
  signal: AbortSignal;
  callId: string;
}

/** A tool as this app defines it, before it is wrapped for the Agent SDK. */
export interface ToolSpec {
  name: string;
  description: string;
  source: ToolSource;
  inputSchema: z.ZodObject;
  timeoutMs?: number;
  run(args: unknown, ctx: ToolRunContext): Promise<unknown>;
  /** Called once the call has been logged, just before its result goes back to the model. */
  onSettled?(): void;
}

/**
 * The run a tool call belongs to, as seen by the guard. A one-off "test tool" call from
 * the UI uses a host with no run and a no-op emitter.
 */
export interface ToolHost {
  accountId: string;
  runId: string | null;
  agent: string;
  depth: number;
  signal: AbortSignal;
  emit(event: RunEventData): void;
  /** Resolves immediately unless the run is paused; then waits for resume or cancel. */
  waitIfPaused(): Promise<void>;
  /** True when a human approved this specific call. */
  wasApproved(callId: string): boolean;
}
