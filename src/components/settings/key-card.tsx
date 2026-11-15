"use client";

import { useState } from "react";
import { usd } from "@/lib/shared/format";
import { ConnectKey, useSession } from "../session";
import { Badge, Button, Card, Notice, Spinner } from "../ui";

/** Shows the connected key (by hint only) and lets the user disconnect or destroy it. */
export function KeyCard() {
  const session = useSession();
  const [busy, setBusy] = useState<"signout" | "forget" | null>(null);

  if (session.loading) {
    return (
      <Card className="flex justify-center p-6">
        <Spinner />
      </Card>
    );
  }
  if (!session.connected) return <ConnectKey compact />;
  const key = session.key;

  async function disconnect(forget: boolean) {
    if (forget && !window.confirm("Delete the stored key from this server? Your agents, runs and logs are kept and reattach if you connect the same key again.")) return;
    setBusy(forget ? "forget" : "signout");
    try {
      await session.disconnect(forget);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">OpenRouter key</h2>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-[13px]">
            <span className="font-mono text-xs text-muted">{session.keyHint}</span>
            <Badge>{session.source === "oauth" ? "via OAuth" : "pasted"}</Badge>
            {key?.isFreeTier ? <Badge tone="warn">free tier</Badge> : null}
            {key?.isManagementKey ? <Badge tone="accent">management key</Badge> : null}
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => void disconnect(false)} loading={busy === "signout"}>Sign out</Button>
          <Button variant="danger" onClick={() => void disconnect(true)} loading={busy === "forget"}>Delete stored key</Button>
        </div>
      </div>
      {session.keyError ? <Notice tone="err" className="mt-3">OpenRouter could not verify this key: {session.keyError}</Notice> : null}
      {key ? (
        <dl className="tabular mt-4 grid grid-cols-2 gap-x-6 gap-y-3 text-[13px] sm:grid-cols-4">
          <div><dt className="text-xs text-muted">Used (all time)</dt><dd className="font-medium">{usd(key.usage)}</dd></div>
          <div><dt className="text-xs text-muted">Used today</dt><dd className="font-medium">{usd(key.usageDaily)}</dd></div>
          <div><dt className="text-xs text-muted">Key limit</dt><dd className="font-medium">{key.limit !== null ? usd(key.limit) : "none"}</dd></div>
          <div><dt className="text-xs text-muted">Remaining</dt><dd className="font-medium">{key.limitRemaining !== null ? usd(key.limitRemaining) : "—"}</dd></div>
          {key.expiresAt ? (
            <div className="col-span-2"><dt className="text-xs text-muted">Expires</dt><dd className="font-medium">{new Date(key.expiresAt).toLocaleString()}</dd></div>
          ) : null}
        </dl>
      ) : null}
      <p className="mt-4 text-xs text-faint">
        The key is sealed with AES-256-GCM on the server and only ever used server-side. This page shows a hint, never the key.
      </p>
    </Card>
  );
}
