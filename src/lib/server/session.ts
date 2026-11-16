import "server-only";
import { cookies } from "next/headers";
import { and, eq, gt, lt } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { ApiError } from "./api";
import { decrypt, encrypt, newId, randomToken, sha256 } from "./crypto";
import { env } from "./env";

const COOKIE = "ors_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface Account {
  id: string;
  keyHint: string;
  source: "paste" | "oauth";
  /** Decrypts on demand so the plaintext key lives only as long as a request needs it. */
  apiKey(): string;
}

function toAccount(row: typeof schema.accounts.$inferSelect): Account {
  return {
    id: row.id,
    keyHint: row.keyHint,
    source: row.source,
    apiKey: () => decrypt(row.keyEnc),
  };
}

export async function getAccount(): Promise<Account | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  const db = getDb();
  const row = db
    .select({ account: schema.accounts })
    .from(schema.sessions)
    .innerJoin(schema.accounts, eq(schema.sessions.accountId, schema.accounts.id))
    .where(and(eq(schema.sessions.id, sha256(token)), gt(schema.sessions.expiresAt, Date.now())))
    .get();
  return row ? toAccount(row.account) : null;
}

export async function requireAccount(): Promise<Account> {
  const account = await getAccount();
  if (!account) throw new ApiError(401, "no_key", "Connect an OpenRouter API key first.");
  return account;
}

export function getAccountById(accountId: string): Account | null {
  const row = getDb().select().from(schema.accounts).where(eq(schema.accounts.id, accountId)).get();
  return row ? toAccount(row) : null;
}

/** Shows enough of the key to recognize it, never enough to use it. */
function hint(key: string): string {
  return key.length > 12 ? `${key.slice(0, 8)}…${key.slice(-4)}` : "…";
}

/** Stores (or re-seals) a key and signs the browser in to the account that owns it. */
export async function signInWithKey(apiKey: string, source: "paste" | "oauth"): Promise<Account> {
  const db = getDb();
  const keyHash = sha256(apiKey);
  const existing = db.select().from(schema.accounts).where(eq(schema.accounts.keyHash, keyHash)).get();
  const id = existing?.id ?? newId("acct");
  if (existing) {
    db.update(schema.accounts)
      .set({ keyEnc: encrypt(apiKey), source, updatedAt: Date.now() })
      .where(eq(schema.accounts.id, id))
      .run();
  } else {
    db.insert(schema.accounts)
      .values({ id, keyHash, keyEnc: encrypt(apiKey), keyHint: hint(apiKey), source })
      .run();
  }

  const token = randomToken();
  const expiresAt = Date.now() + SESSION_TTL_MS;
  db.delete(schema.sessions).where(lt(schema.sessions.expiresAt, Date.now())).run();
  db.insert(schema.sessions).values({ id: sha256(token), accountId: id, expiresAt }).run();
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.appUrl.startsWith("https://"),
    path: "/",
    expires: new Date(expiresAt),
  });
  return getAccountById(id)!;
}

/**
 * Signs out. With `forget`, the stored key is destroyed too; agents, runs and logs stay,
 * and reattach if the same key is connected again (accounts are keyed by the key's hash).
 */
export async function signOut(forget: boolean): Promise<void> {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  jar.delete(COOKIE);
  if (!token) return;
  const db = getDb();
  const session = db.select().from(schema.sessions).where(eq(schema.sessions.id, sha256(token))).get();
  if (!session) return;
  if (forget) {
    // Overwrite the ciphertext rather than deleting the row, so owned data keeps its account id.
    db.update(schema.accounts)
      .set({ keyEnc: encrypt(""), updatedAt: Date.now() })
      .where(eq(schema.accounts.id, session.accountId))
      .run();
    db.delete(schema.sessions).where(eq(schema.sessions.accountId, session.accountId)).run();
  } else {
    db.delete(schema.sessions).where(eq(schema.sessions.id, session.id)).run();
  }
}
