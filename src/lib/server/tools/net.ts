import "server-only";
import dns from "node:dns/promises";
import net from "node:net";
import { env } from "../env";

/**
 * Outbound HTTP for model-driven tools. The model chooses the URL, so this is where
 * server-side request forgery is stopped: only http(s), no private / loopback /
 * link-local / metadata addresses (unless explicitly allowed), redirects re-checked hop
 * by hop, and hard caps on time and response size.
 */

export class NetError extends Error {}

const MAX_REDIRECTS = 5;
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

const V4_BLOCKS: [string, number][] = [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, incl. cloud metadata (169.254.169.254)
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved
];

export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const n = ipv4ToInt(ip);
    return V4_BLOCKS.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (n & mask) === (ipv4ToInt(base) & mask);
    });
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    // IPv4-mapped (::ffff:a.b.c.d): judge by the embedded IPv4 address.
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    // fc00::/7 unique-local, fe80::/10 link-local, ff00::/8 multicast
    return /^(fc|fd)/.test(lower) || /^fe[89ab]/.test(lower) || lower.startsWith("ff");
  }
  return true; // not an IP at all: refuse
}

/** Throws unless `url` is an http(s) URL that resolves only to public addresses. */
export async function assertPublicUrl(raw: string, allowPrivate = env.allowPrivateNetwork): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new NetError("Not a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new NetError("Only http and https URLs are allowed.");
  if (url.username || url.password) throw new NetError("URLs with embedded credentials are not allowed.");
  if (allowPrivate) return url;

  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new NetError("Requests to private or loopback addresses are blocked.");
    return url;
  }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new NetError("Requests to local hostnames are blocked.");
  }

  let addresses: string[];
  try {
    addresses = (await dns.lookup(host, { all: true })).map((a) => a.address);
  } catch {
    // Behind a forward proxy this host may have no DNS of its own; the proxy resolves and
    // connects on our behalf, so the request cannot reach this machine's private network.
    if (process.env.HTTPS_PROXY || process.env.https_proxy) return url;
    throw new NetError(`Could not resolve ${host}.`);
  }
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new NetError("That hostname resolves to a private or loopback address, which is blocked.");
  }
  return url;
}

export interface SafeFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
  allowPrivate?: boolean;
}

export interface SafeFetchResult {
  url: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
}

// Hop-by-hop and identity headers a tool caller has no business setting.
const FORBIDDEN_HEADERS = new Set(["host", "content-length", "connection", "transfer-encoding", "cookie", "proxy-authorization"]);

export async function safeFetch(rawUrl: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const maxBytes = opts.maxBytes ?? MAX_BODY_BYTES;

  const headers: Record<string, string> = { "User-Agent": "OpenRouterStudio/1.0 (agent tool)" };
  for (const [k, v] of Object.entries(opts.headers ?? {})) {
    if (!FORBIDDEN_HEADERS.has(k.toLowerCase())) headers[k] = String(v);
  }

  let method = (opts.method ?? "GET").toUpperCase();
  let body = opts.body;
  let current = rawUrl;

  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const url = await assertPublicUrl(current, opts.allowPrivate);
      // Redirects are followed by hand so every hop is checked, not just the first.
      const res = await fetch(url, { method, headers, body: method === "GET" || method === "HEAD" ? undefined : body, redirect: "manual", signal });

      if (res.status >= 300 && res.status < 400 && res.headers.has("location")) {
        await res.body?.cancel().catch(() => {});
        current = new URL(res.headers.get("location")!, url).toString();
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
          method = "GET";
          body = undefined;
        }
        continue;
      }

      const chunks: Uint8Array[] = [];
      let size = 0;
      let truncated = false;
      if (res.body) {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (size + value.byteLength > maxBytes) {
            chunks.push(value.subarray(0, maxBytes - size));
            truncated = true;
            await reader.cancel().catch(() => {});
            break;
          }
          chunks.push(value);
          size += value.byteLength;
        }
      }
      return {
        url: url.toString(),
        status: res.status,
        headers: Object.fromEntries(res.headers.entries()),
        body: Buffer.concat(chunks).toString("utf8"),
        truncated,
      };
    }
    throw new NetError(`Too many redirects (more than ${MAX_REDIRECTS}).`);
  } catch (err) {
    if (err instanceof NetError) throw err;
    if (timeout.aborted) throw new NetError("The request timed out.");
    if (opts.signal?.aborted) throw new NetError("The request was cancelled.");
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    throw new NetError(`Request failed: ${cause?.code ?? cause?.message ?? (err as Error).message}`);
  }
}

/** Reduces an HTML document to readable text so a page fits in a model's context. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*/g, "\n\n")
    .trim();
}
