import { eq } from "drizzle-orm";
import { connection } from "next/server";
import { getDb, schema } from "@/db";
import { decrypt } from "@/lib/server/crypto";
import { env } from "@/lib/server/env";
import { orJson } from "@/lib/server/openrouter";
import { signInWithKey } from "@/lib/server/session";

function back(error?: string) {
  const url = new URL(env.appUrl);
  if (error) url.searchParams.set("auth_error", error);
  return Response.redirect(url.toString(), 302);
}

/** OAuth PKCE, step 2: exchange the code (plus our verifier) for a user-controlled key. */
export async function GET(req: Request) {
  await connection();
  const params = new URL(req.url).searchParams;
  const code = params.get("code");
  const state = params.get("state");
  if (!code || !state) return back("OpenRouter did not return an authorization code.");

  const db = getDb();
  const row = db.select().from(schema.oauthStates).where(eq(schema.oauthStates.state, state)).get();
  if (!row) return back("This sign-in link expired. Please try again.");
  // Single use: a replayed callback finds nothing.
  db.delete(schema.oauthStates).where(eq(schema.oauthStates.state, state)).run();

  try {
    const { key } = await orJson<{ key: string }>(
      null,
      "/auth/keys",
      { method: "POST", body: { code, code_verifier: decrypt(row.verifierEnc), code_challenge_method: "S256" } },
      { accountId: "anon", kind: "meta" },
    );
    if (!key) return back("OpenRouter did not return a key.");
    await signInWithKey(key, "oauth");
    return back();
  } catch (err) {
    return back((err as Error).message);
  }
}
