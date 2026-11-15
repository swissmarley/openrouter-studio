import crypto from "node:crypto";
import { lt } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { route } from "@/lib/server/api";
import { encrypt, randomToken } from "@/lib/server/crypto";
import { env } from "@/lib/server/env";

/**
 * OAuth PKCE, step 1: send the user to OpenRouter with an S256 challenge. The verifier
 * stays on the server (sealed), so the authorization code is useless to anyone else.
 */
export const GET = route(async () => {
  const db = getDb();
  db.delete(schema.oauthStates).where(lt(schema.oauthStates.createdAt, Date.now() - 15 * 60 * 1000)).run();

  const verifier = randomToken(48);
  const state = randomToken(24);
  db.insert(schema.oauthStates).values({ state, verifierEnc: encrypt(verifier) }).run();

  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const url = new URL(env.openrouterAuthUrl);
  url.searchParams.set("callback_url", `${env.appUrl}/api/auth/oauth/callback`);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("key_label", "OpenRouter Studio");
  return Response.redirect(url.toString(), 302);
});
