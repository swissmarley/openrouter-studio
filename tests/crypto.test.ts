import { describe, expect, it } from "vitest";
import { decrypt, encrypt, sha256 } from "@/lib/server/crypto";

describe("secret sealing", () => {
  it("round-trips and never emits the plaintext", () => {
    const sealed = encrypt("sk-or-v1-secret-value");
    expect(sealed).not.toContain("sk-or-v1");
    expect(decrypt(sealed)).toBe("sk-or-v1-secret-value");
  });

  it("uses a fresh nonce each time", () => {
    expect(encrypt("same")).not.toBe(encrypt("same"));
  });

  it("rejects tampered ciphertext", () => {
    const parts = encrypt("value").split(":");
    const ct = Buffer.from(parts[3], "base64");
    ct[0] ^= 1;
    parts[3] = ct.toString("base64");
    expect(() => decrypt(parts.join(":"))).toThrow();
    expect(() => decrypt("garbage")).toThrow();
  });

  it("hashes deterministically", () => {
    expect(sha256("a")).toBe(sha256("a"));
    expect(sha256("a")).not.toBe(sha256("b"));
  });
});
