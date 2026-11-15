/** Display helpers shared by every screen. */

/** Per-token USD price shown per million tokens, the unit people actually compare. */
export function pricePerM(perToken: number | null | undefined): string {
  if (perToken === null || perToken === undefined) return "—";
  if (perToken < 0) return "varies";
  if (perToken === 0) return "free";
  const v = perToken * 1_000_000;
  if (v >= 100) return `$${v.toFixed(0)}`;
  if (v >= 1) return `$${v.toFixed(2)}`;
  if (v >= 0.01) return `$${v.toFixed(3)}`;
  return `$${v.toPrecision(2)}`;
}

/** A dollar amount that stays readable from fractions of a cent up. */
export function usd(amount: number | null | undefined): string {
  if (amount === null || amount === undefined) return "—";
  if (amount === 0) return "$0";
  const abs = Math.abs(amount);
  if (abs >= 100) return `$${amount.toFixed(0)}`;
  if (abs >= 1) return `$${amount.toFixed(2)}`;
  if (abs >= 0.01) return `$${amount.toFixed(4)}`;
  return `$${amount.toPrecision(2)}`;
}

export function tokens(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 2)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}K`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function timeAgo(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86_400 * 30) return `${Math.floor(s / 86_400)}d ago`;
  return new Date(ts).toLocaleDateString();
}

export function dateTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}
