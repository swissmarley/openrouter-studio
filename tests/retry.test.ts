import { describe, expect, it } from "vitest";
import { backoffDelay, isRetryableStatus, parseRetryAfter } from "@/lib/shared/retry";

describe("retry policy", () => {
  it("retries rate limits, timeouts and server errors only", () => {
    for (const s of [408, 429, 500, 502, 503, 504]) expect(isRetryableStatus(s)).toBe(true);
    for (const s of [200, 400, 401, 402, 403, 404, 422]) expect(isRetryableStatus(s)).toBe(false);
  });

  it("parses Retry-After as seconds or an HTTP date", () => {
    expect(parseRetryAfter("2")).toBe(2000);
    expect(parseRetryAfter("0")).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("nonsense")).toBeNull();
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:05 GMT", now)).toBe(5000);
    expect(parseRetryAfter("Thu, 01 Jan 2025 00:00:00 GMT", now)).toBeNull();
  });

  it("honors Retry-After but caps it", () => {
    expect(backoffDelay(0, 1500)).toBe(1500);
    expect(backoffDelay(0, 120_000)).toBe(30_000);
  });

  it("backs off exponentially with jitter inside [half, full] of the ceiling", () => {
    const lo = { random: () => 0 };
    const hi = { random: () => 1 };
    expect(backoffDelay(0, null, lo)).toBe(250);
    expect(backoffDelay(0, null, hi)).toBe(500);
    expect(backoffDelay(2, null, lo)).toBe(1000);
    expect(backoffDelay(2, null, hi)).toBe(2000);
    // never exceeds the cap however many attempts
    expect(backoffDelay(20, null, hi)).toBe(8000);
  });
});
