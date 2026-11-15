import "server-only";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { env } from "./env";

/**
 * Secrets at rest (OpenRouter keys, MCP credentials, OAuth verifiers) are sealed with
 * AES-256-GCM. The key is derived from APP_SECRET; if that is unset outside production we
 * generate one and keep it in the data directory so local setups work without ceremony.
 */

const globalForKey = globalThis as unknown as { __orsKey?: Buffer };

function loadSecret(): string {
  if (env.appSecret) {
    if (env.appSecret.length < 16) throw new Error("APP_SECRET must be at least 16 characters.");
    return env.appSecret;
  }
  if (env.isProd) {
    throw new Error("APP_SECRET is required in production. Generate one with: openssl rand -base64 32");
  }
  const file = path.join(env.dataDir, ".app-secret");
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    fs.mkdirSync(env.dataDir, { recursive: true });
    const generated = crypto.randomBytes(32).toString("base64");
    try {
      // "wx" loses the race cleanly if another worker created it first.
      fs.writeFileSync(file, generated, { mode: 0o600, flag: "wx" });
      return generated;
    } catch {
      return fs.readFileSync(file, "utf8").trim();
    }
  }
}

function key(): Buffer {
  return (globalForKey.__orsKey ??= crypto.scryptSync(loadSecret(), "openrouter-studio/v1", 32));
}

export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), ct.toString("base64")].join(":");
}

export function decrypt(sealed: string): string {
  const [version, iv, tag, ct] = sealed.split(":");
  if (version !== "v1" || !iv || !tag || !ct) throw new Error("Unrecognized ciphertext format.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64")), decipher.final()]).toString("utf8");
}

export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(9).toString("base64url")}`;
}
