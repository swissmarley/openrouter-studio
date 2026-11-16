CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`key_hash` text NOT NULL,
	`key_enc` text NOT NULL,
	`key_hint` text NOT NULL,
	`source` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_key_hash_idx` ON `accounts` (`key_hash`);--> statement-breakpoint
CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`config` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `agents_account_idx` ON `agents` (`account_id`);--> statement-breakpoint
CREATE TABLE `custom_tools` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`schema_source` text NOT NULL,
	`code` text NOT NULL,
	`require_approval` integer DEFAULT false NOT NULL,
	`allow_network` integer DEFAULT false NOT NULL,
	`timeout_ms` integer DEFAULT 5000 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `custom_tools_account_name_idx` ON `custom_tools` (`account_id`,`name`);--> statement-breakpoint
CREATE TABLE `eval_datasets` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`name` text NOT NULL,
	`rows` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `eval_datasets_account_idx` ON `eval_datasets` (`account_id`);--> statement-breakpoint
CREATE TABLE `eval_results` (
	`id` text PRIMARY KEY NOT NULL,
	`eval_id` text NOT NULL,
	`row_index` integer NOT NULL,
	`model` text NOT NULL,
	`model_used` text,
	`output` text,
	`score` real,
	`score_detail` text,
	`latency_ms` integer,
	`ttft_ms` integer,
	`prompt_tokens` integer,
	`completion_tokens` integer,
	`cost` real,
	`judge_cost` real,
	`error` text,
	FOREIGN KEY (`eval_id`) REFERENCES `evals`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `eval_results_eval_idx` ON `eval_results` (`eval_id`);--> statement-breakpoint
CREATE TABLE `evals` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`name` text NOT NULL,
	`config` text NOT NULL,
	`status` text NOT NULL,
	`total` integer DEFAULT 0 NOT NULL,
	`done` integer DEFAULT 0 NOT NULL,
	`error` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`ended_at` integer
);
--> statement-breakpoint
CREATE INDEX `evals_account_created_idx` ON `evals` (`account_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `mcp_servers` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`auth_kind` text DEFAULT 'none' NOT NULL,
	`auth_enc` text,
	`require_approval` integer DEFAULT true NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`tools_cache` text,
	`last_status` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_servers_account_name_idx` ON `mcp_servers` (`account_id`,`name`);--> statement-breakpoint
CREATE TABLE `oauth_states` (
	`state` text PRIMARY KEY NOT NULL,
	`verifier_enc` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `request_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`ts` integer NOT NULL,
	`kind` text NOT NULL,
	`endpoint` text NOT NULL,
	`method` text NOT NULL,
	`model` text,
	`model_used` text,
	`provider` text,
	`status` integer,
	`ok` integer NOT NULL,
	`streamed` integer DEFAULT false NOT NULL,
	`latency_ms` integer,
	`ttft_ms` integer,
	`retries` integer DEFAULT 0 NOT NULL,
	`prompt_tokens` integer,
	`completion_tokens` integer,
	`reasoning_tokens` integer,
	`cached_tokens` integer,
	`cost` real,
	`generation_id` text,
	`finish_reason` text,
	`error` text,
	`ref_type` text,
	`ref_id` text
);
--> statement-breakpoint
CREATE INDEX `request_logs_account_ts_idx` ON `request_logs` (`account_id`,`ts`);--> statement-breakpoint
CREATE INDEX `request_logs_ref_idx` ON `request_logs` (`ref_type`,`ref_id`);--> statement-breakpoint
CREATE TABLE `run_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`ts` integer NOT NULL,
	`type` text NOT NULL,
	`data` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_events_run_seq_idx` ON `run_events` (`run_id`,`seq`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`agent_id` text,
	`agent_name` text NOT NULL,
	`snapshot` text NOT NULL,
	`parent_run_id` text,
	`replay_of` text,
	`input` text NOT NULL,
	`status` text NOT NULL,
	`output` text,
	`error` text,
	`stop_reason` text,
	`state` text,
	`steps` integer DEFAULT 0 NOT NULL,
	`prompt_tokens` integer DEFAULT 0 NOT NULL,
	`completion_tokens` integer DEFAULT 0 NOT NULL,
	`cost` real DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`started_at` integer,
	`ended_at` integer
);
--> statement-breakpoint
CREATE INDEX `runs_account_created_idx` ON `runs` (`account_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `runs_parent_idx` ON `runs` (`parent_run_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_account_idx` ON `sessions` (`account_id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`account_id` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `tool_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`run_id` text,
	`agent_name` text,
	`tool_name` text NOT NULL,
	`source` text NOT NULL,
	`args` text NOT NULL,
	`result` text,
	`status` text NOT NULL,
	`approval` text DEFAULT 'auto' NOT NULL,
	`duration_ms` integer,
	`ts` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `tool_calls_account_ts_idx` ON `tool_calls` (`account_id`,`ts`);--> statement-breakpoint
CREATE INDEX `tool_calls_run_idx` ON `tool_calls` (`run_id`);