import { sql } from "drizzle-orm";
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const now = sql`(unixepoch() * 1000)`;

/** One account per distinct OpenRouter key. The key itself is only ever stored encrypted. */
export const accounts = sqliteTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    keyHash: text("key_hash").notNull(),
    keyEnc: text("key_enc").notNull(),
    keyHint: text("key_hint").notNull(),
    source: text("source", { enum: ["paste", "oauth"] }).notNull(),
    createdAt: integer("created_at").notNull().default(now),
    updatedAt: integer("updated_at").notNull().default(now),
  },
  (t) => [uniqueIndex("accounts_key_hash_idx").on(t.keyHash)],
);

export const sessions = sqliteTable(
  "sessions",
  {
    /** sha256 of the cookie token; the raw token never touches the database. */
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull().default(now),
    expiresAt: integer("expires_at").notNull(),
  },
  (t) => [index("sessions_account_idx").on(t.accountId)],
);

export const oauthStates = sqliteTable("oauth_states", {
  state: text("state").primaryKey(),
  verifierEnc: text("verifier_enc").notNull(),
  createdAt: integer("created_at").notNull().default(now),
});

export const settings = sqliteTable("settings", {
  accountId: text("account_id")
    .primaryKey()
    .references(() => accounts.id, { onDelete: "cascade" }),
  data: text("data", { mode: "json" }).notNull().$type<Record<string, unknown>>(),
  updatedAt: integer("updated_at").notNull().default(now),
});

/** Every upstream OpenRouter call made through the server-side proxy. */
export const requestLogs = sqliteTable(
  "request_logs",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    ts: integer("ts").notNull(),
    kind: text("kind").notNull(), // chat | responses | agent | eval | meta
    endpoint: text("endpoint").notNull(),
    method: text("method").notNull(),
    model: text("model"),
    modelUsed: text("model_used"),
    provider: text("provider"),
    status: integer("status"),
    ok: integer("ok", { mode: "boolean" }).notNull(),
    streamed: integer("streamed", { mode: "boolean" }).notNull().default(false),
    latencyMs: integer("latency_ms"),
    ttftMs: integer("ttft_ms"),
    retries: integer("retries").notNull().default(0),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    reasoningTokens: integer("reasoning_tokens"),
    cachedTokens: integer("cached_tokens"),
    cost: real("cost"),
    generationId: text("generation_id"),
    finishReason: text("finish_reason"),
    error: text("error"),
    refType: text("ref_type"), // run | eval
    refId: text("ref_id"),
  },
  (t) => [
    index("request_logs_account_ts_idx").on(t.accountId, t.ts),
    index("request_logs_ref_idx").on(t.refType, t.refId),
  ],
);

export const agents = sqliteTable(
  "agents",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    config: text("config", { mode: "json" }).notNull().$type<Record<string, unknown>>(),
    createdAt: integer("created_at").notNull().default(now),
    updatedAt: integer("updated_at").notNull().default(now),
  },
  (t) => [index("agents_account_idx").on(t.accountId)],
);

export const customTools = sqliteTable(
  "custom_tools",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    schemaSource: text("schema_source").notNull(),
    code: text("code").notNull(),
    requireApproval: integer("require_approval", { mode: "boolean" }).notNull().default(false),
    allowNetwork: integer("allow_network", { mode: "boolean" }).notNull().default(false),
    timeoutMs: integer("timeout_ms").notNull().default(5000),
    createdAt: integer("created_at").notNull().default(now),
    updatedAt: integer("updated_at").notNull().default(now),
  },
  (t) => [uniqueIndex("custom_tools_account_name_idx").on(t.accountId, t.name)],
);

export const mcpServers = sqliteTable(
  "mcp_servers",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    name: text("name").notNull(),
    url: text("url").notNull(),
    authKind: text("auth_kind", { enum: ["none", "bearer", "headers"] }).notNull().default("none"),
    /** Encrypted JSON: { token } or { headers }. */
    authEnc: text("auth_enc"),
    requireApproval: integer("require_approval", { mode: "boolean" }).notNull().default(true),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    toolsCache: text("tools_cache", { mode: "json" }).$type<{ name: string; description?: string }[]>(),
    lastStatus: text("last_status"),
    createdAt: integer("created_at").notNull().default(now),
    updatedAt: integer("updated_at").notNull().default(now),
  },
  (t) => [uniqueIndex("mcp_servers_account_name_idx").on(t.accountId, t.name)],
);

export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    agentId: text("agent_id"),
    agentName: text("agent_name").notNull(),
    /** Frozen copy of the agent (and every agent it can reach) at launch, so a run replays exactly. */
    snapshot: text("snapshot", { mode: "json" }).notNull().$type<Record<string, unknown>>(),
    parentRunId: text("parent_run_id"),
    replayOf: text("replay_of"),
    input: text("input").notNull(),
    status: text("status").notNull(),
    output: text("output"),
    error: text("error"),
    stopReason: text("stop_reason"),
    /** Serialized @openrouter/agent ConversationState, used to resume after approval. */
    state: text("state"),
    steps: integer("steps").notNull().default(0),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    cost: real("cost").notNull().default(0),
    createdAt: integer("created_at").notNull().default(now),
    startedAt: integer("started_at"),
    endedAt: integer("ended_at"),
  },
  (t) => [
    index("runs_account_created_idx").on(t.accountId, t.createdAt),
    index("runs_parent_idx").on(t.parentRunId),
  ],
);

export const runEvents = sqliteTable(
  "run_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    ts: integer("ts").notNull(),
    type: text("type").notNull(),
    data: text("data", { mode: "json" }).notNull().$type<Record<string, unknown>>(),
  },
  (t) => [uniqueIndex("run_events_run_seq_idx").on(t.runId, t.seq)],
);

/** Audit log: every tool invocation, whatever its outcome. */
export const toolCalls = sqliteTable(
  "tool_calls",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    runId: text("run_id"),
    agentName: text("agent_name"),
    toolName: text("tool_name").notNull(),
    source: text("source").notNull(), // builtin | custom | mcp | agent
    args: text("args").notNull(),
    result: text("result"),
    status: text("status").notNull(), // ok | error | rejected | rate_limited | timeout
    approval: text("approval").notNull().default("auto"), // auto | approved | rejected
    durationMs: integer("duration_ms"),
    ts: integer("ts").notNull(),
  },
  (t) => [
    index("tool_calls_account_ts_idx").on(t.accountId, t.ts),
    index("tool_calls_run_idx").on(t.runId),
  ],
);

export const evalDatasets = sqliteTable(
  "eval_datasets",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    name: text("name").notNull(),
    rows: text("rows", { mode: "json" }).notNull().$type<{ input: string; expected?: string }[]>(),
    createdAt: integer("created_at").notNull().default(now),
    updatedAt: integer("updated_at").notNull().default(now),
  },
  (t) => [index("eval_datasets_account_idx").on(t.accountId)],
);

export const evals = sqliteTable(
  "evals",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    name: text("name").notNull(),
    config: text("config", { mode: "json" }).notNull().$type<Record<string, unknown>>(),
    status: text("status").notNull(), // running | completed | failed | cancelled
    total: integer("total").notNull().default(0),
    done: integer("done").notNull().default(0),
    error: text("error"),
    createdAt: integer("created_at").notNull().default(now),
    endedAt: integer("ended_at"),
  },
  (t) => [index("evals_account_created_idx").on(t.accountId, t.createdAt)],
);

export const evalResults = sqliteTable(
  "eval_results",
  {
    id: text("id").primaryKey(),
    evalId: text("eval_id")
      .notNull()
      .references(() => evals.id, { onDelete: "cascade" }),
    rowIndex: integer("row_index").notNull(),
    model: text("model").notNull(),
    modelUsed: text("model_used"),
    output: text("output"),
    score: real("score"),
    scoreDetail: text("score_detail"),
    latencyMs: integer("latency_ms"),
    ttftMs: integer("ttft_ms"),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    cost: real("cost"),
    judgeCost: real("judge_cost"),
    error: text("error"),
  },
  (t) => [index("eval_results_eval_idx").on(t.evalId)],
);
