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
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiClientError | null>(null);
  const [loading, setLoading] = useState(url !== null);
  const latest = useRef(0);

  const load = useCallback(async () => {
    if (url === null) return;
    const ticket = ++latest.current;
    try {
      const next = await api.get<T>(url);
      // Ignore responses that were overtaken by a newer request.
      if (ticket !== latest.current) return;
      setData(next);
      setError(null);
    } catch (err) {
      if (ticket !== latest.current) return;
      setError(err instanceof ApiClientError ? err : new ApiClientError(0, "network", (err as Error).message));
    } finally {
      if (ticket === latest.current) setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    if (url === null) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void load();
    if (!opts.pollMs) return;
    const timer = setInterval(() => void load(), opts.pollMs);
    return () => clearInterval(timer);
  }, [url, load, opts.pollMs]);

  return { data, error, loading, reload: load, setData };
}
