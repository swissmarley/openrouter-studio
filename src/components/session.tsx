"use client";

import { createContext, useCallback, useContext, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { KeyRound, LogIn } from "lucide-react";
import { api, ApiClientError } from "@/lib/client/api";
import { Button, Card, Field, Input, Notice, Spinner } from "./ui";

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

export interface SessionState {
  loading: boolean;
  connected: boolean;
  keyHint?: string;
  source?: "paste" | "oauth";
  key?: KeyInfo | null;
  keyError?: string | null;
}

interface SessionContext extends SessionState {
  refresh: () => Promise<void>;
  disconnect: (forget: boolean) => Promise<void>;
}

const Ctx = createContext<SessionContext | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ loading: true, connected: false });

  const refresh = useCallback(async () => {
    try {
      const next = await api.get<Omit<SessionState, "loading">>("/api/auth/status");
      setState({ loading: false, ...next });
    } catch {
      setState({ loading: false, connected: false });
    }
  }, []);

  const disconnect = useCallback(
    async (forget: boolean) => {
      await api.del(`/api/auth/key${forget ? "?forget=1" : ""}`);
      await refresh();
    },
    [refresh],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return <Ctx.Provider value={{ ...state, refresh, disconnect }}>{children}</Ctx.Provider>;
}

export function useSession(): SessionContext {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useSession must be used inside <SessionProvider>.");
  return ctx;
}

/** The connect form: paste a key, or go through OpenRouter's OAuth PKCE flow. */
export function ConnectKey({ compact }: { compact?: boolean }) {
  const { refresh } = useSession();
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // The OAuth callback reports failures through the query string.
    const params = new URLSearchParams(window.location.search);
    const authError = params.get("auth_error");
    if (authError) {
      setError(authError);
      params.delete("auth_error");
      const qs = params.toString();
      window.history.replaceState(null, "", window.location.pathname + (qs ? `?${qs}` : ""));
    }
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/auth/key", { apiKey });
      setApiKey("");
      await refresh();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not connect. Check your network and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className={compact ? "p-4" : "mx-auto w-full max-w-md p-6"}>
      <div className="mb-4 flex items-center gap-2">
        <span className="flex size-8 items-center justify-center rounded-md bg-accent-soft text-accent-text">
          <KeyRound className="size-4" />
        </span>
        <div>
          <h2 className="text-sm font-semibold">Connect your OpenRouter key</h2>
          <p className="text-xs text-muted">Encrypted on the server. It is never sent back to this browser.</p>
        </div>
      </div>
      <form onSubmit={submit} className="space-y-3">
        <Field label="API key">
          <Input
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="sk-or-v1-…"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            aria-invalid={error ? true : undefined}
          />
        </Field>
        {error ? <Notice tone="err">{error}</Notice> : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" variant="primary" loading={busy} disabled={apiKey.trim().length < 8}>
            Connect key
          </Button>
          <span className="text-xs text-faint">or</span>
          {/* A full navigation, not fetch: OpenRouter needs to show its consent page. */}
          <a
            href="/api/auth/oauth/start"
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line bg-panel px-3 text-[13px] font-medium hover:bg-hover"
          >
            <LogIn className="size-3.5" />
            Sign in with OpenRouter
          </a>
        </div>
        <p className="text-xs text-faint">
          Create a key at{" "}
          <a className="underline hover:text-fg" href="https://openrouter.ai/keys" target="_blank" rel="noreferrer">
            openrouter.ai/keys
          </a>
          . Setting a credit limit on it is a good idea.
        </p>
      </form>
    </Card>
  );
}

/** Renders children only once a key is connected; otherwise shows the connect form. */
export function RequireKey({ children }: { children: ReactNode }) {
  const session = useSession();
  if (session.loading) {
    return (
      <div className="flex flex-1 items-center justify-center p-10">
        <Spinner />
      </div>
    );
  }
  if (!session.connected) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <ConnectKey />
      </div>
    );
  }
  return <>{children}</>;
}
