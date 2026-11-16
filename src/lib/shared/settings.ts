import { z } from "zod";

export const settingsSchema = z.object({
  defaults: z
    .object({
      chatModel: z.string().min(1).max(200).default("~anthropic/claude-haiku-latest"),
      agentModel: z.string().min(1).max(200).default("~anthropic/claude-haiku-latest"),
      judgeModel: z.string().min(1).max(200).default("~openai/gpt-luna-latest"),
    })
    .prefault({}),
  budgets: z
    .object({
      /** Spend caps in USD, measured from this app's own request log. null = no cap. */
      dailyUsd: z.number().positive().max(1_000_000).nullable().default(null),
      monthlyUsd: z.number().positive().max(1_000_000).nullable().default(null),
      /** Fractions of a cap at which to raise an alert. */
      alertThresholds: z.array(z.number().gt(0).max(1)).max(6).default([0.5, 0.8, 1]),
      /** Refuse new model calls once a cap is reached, instead of only alerting. */
      hardStop: z.boolean().default(false),
    })
    .prefault({}),
  tools: z
    .object({
      rateLimitPerMin: z.number().int().min(1).max(10_000).default(60),
    })
    .prefault({}),
});

export type Settings = z.infer<typeof settingsSchema>;

export const defaultSettings: Settings = settingsSchema.parse({});
