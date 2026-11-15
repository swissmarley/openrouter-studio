import "server-only";
import path from "node:path";

function bool(v: string | undefined, fallback: boolean) {
  if (v === undefined || v === "") return fallback;
  return v === "1" || v.toLowerCase() === "true";
}

function int(v: string | undefined, fallback: number) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export const env = {
  /** Where the SQLite file, generated secret and agent workspaces live. */
  dataDir: path.resolve(process.env.DATA_DIR || "./data"),
  appSecret: process.env.APP_SECRET || "",
  /** Public origin of this app, used for attribution headers and the OAuth callback. */
  appUrl: (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, ""),
  openrouterBaseUrl: (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/$/, ""),
  openrouterAuthUrl: (process.env.OPENROUTER_AUTH_URL || "https://openrouter.ai/auth").replace(/\/$/, ""),
  maxRetries: int(process.env.OPENROUTER_MAX_RETRIES, 3),
  /** Let model-driven tools (web_fetch, http_request, sandbox fetch) reach private/loopback addresses. */
  allowPrivateNetwork: bool(process.env.TOOLS_ALLOW_PRIVATE_NETWORK, false),
  toolRateLimitPerMin: int(process.env.TOOL_RATE_LIMIT_PER_MIN, 60),
  sandboxTimeoutMs: int(process.env.SANDBOX_TIMEOUT_MS, 5000),
  sandboxMemoryMb: int(process.env.SANDBOX_MEMORY_MB, 64),
  isProd: process.env.NODE_ENV === "production",
};
