import "server-only";
import { orJson } from "./openrouter";

export interface KeyInfo {
  label: string | null;
  limit: number | null;
  limitRemaining: number | null;
  limitReset: string | null;
  usage: number;
  usageDaily: number;
  usageWeekly: number;
  usageMonthly: number;
  byokUsage: number;
  isFreeTier: boolean;
  isManagementKey: boolean;
  expiresAt: string | null;
}

type Raw = Record<string, unknown>;
const num = (v: unknown) => (typeof v === "number" ? v : 0);
const numOrNull = (v: unknown) => (typeof v === "number" ? v : null);
const strOrNull = (v: unknown) => (typeof v === "string" ? v : null);

/** GET /key: metadata about the key itself. Doubles as the validity check when connecting. */
export async function fetchKeyInfo(accountId: string, apiKey: string): Promise<KeyInfo> {
  const body = await orJson<{ data: Raw }>(apiKey, "/key", {}, { accountId, kind: "meta" });
  const d = body.data ?? {};
  return {
    label: strOrNull(d.label),
    limit: numOrNull(d.limit),
    limitRemaining: numOrNull(d.limit_remaining),
    limitReset: strOrNull(d.limit_reset),
    usage: num(d.usage),
    usageDaily: num(d.usage_daily),
    usageWeekly: num(d.usage_weekly),
    usageMonthly: num(d.usage_monthly),
    byokUsage: num(d.byok_usage),
    isFreeTier: d.is_free_tier === true,
    isManagementKey: d.is_management_key === true || d.is_provisioning_key === true,
    expiresAt: strOrNull(d.expires_at),
  };
}
