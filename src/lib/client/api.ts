"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export class ApiClientError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* empty or non-JSON body */
  }
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
    throw new ApiClientError(res.status, err?.code ?? "error", err?.message ?? `Request failed (${res.status}).`, err?.details);
  }
  return data as T;
}

export const api = {
  get: <T>(url: string, signal?: AbortSignal) => request<T>("GET", url, undefined, signal),
  post: <T>(url: string, body?: unknown) => request<T>("POST", url, body ?? {}),
  put: <T>(url: string, body?: unknown) => request<T>("PUT", url, body ?? {}),
  patch: <T>(url: string, body?: unknown) => request<T>("PATCH", url, body ?? {}),
  del: <T>(url: string) => request<T>("DELETE", url),
};

export interface Resource<T> {
  data: T | null;
  error: ApiClientError | null;
  loading: boolean;
  reload: () => Promise<void>;
  setData: (next: T | null) => void;
}

/** Fetch-on-mount with reload. Pass `null` to skip (e.g. while a dependency is unknown). */
export function useResource<T>(url: string | null, opts: { pollMs?: number } = {}): Resource<T> {
  // The result is stored with the URL it answers, so "loading" is simply "no answer for
  // the current URL yet" and never has to be toggled by hand.
  const [result, setResult] = useState<{ url: string; data: T | null; error: ApiClientError | null } | null>(null);
  const latest = useRef(0);

  const load = useCallback((): Promise<void> => {
    if (url === null) return Promise.resolve();
    const ticket = ++latest.current;
    return api.get<T>(url).then(
      (data) => {
        // Ignore responses that were overtaken by a newer request.
        if (ticket === latest.current) setResult({ url, data, error: null });
      },
      (err: unknown) => {
        if (ticket !== latest.current) return;
        const error = err instanceof ApiClientError ? err : new ApiClientError(0, "network", (err as Error).message);
        // Keep showing the last good data if a background refresh fails.
        setResult((prev) => ({ url, data: prev?.url === url ? prev.data : null, error }));
      },
    );
  }, [url]);

  useEffect(() => {
    if (url === null) return;
    void load();
    if (!opts.pollMs) return;
    const timer = setInterval(() => void load(), opts.pollMs);
    return () => clearInterval(timer);
  }, [url, load, opts.pollMs]);

  const current = result && result.url === url ? result : null;
  const setData = useCallback(
    (next: T | null) => {
      if (url !== null) setResult({ url, data: next, error: null });
    },
    [url],
  );
  return { data: current?.data ?? null, error: current?.error ?? null, loading: url !== null && current === null, reload: load, setData };
}
