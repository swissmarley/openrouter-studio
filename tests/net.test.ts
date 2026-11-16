import { describe, expect, it } from "vitest";
import { assertPublicUrl, htmlToText, isPrivateAddress, NetError } from "@/lib/server/tools/net";

describe("SSRF guard", () => {
  it("classifies private, loopback, link-local and metadata addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "192.167.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it("blocks non-http schemes, credentials and local targets", async () => {
    for (const url of [
      "file:///etc/passwd",
      "ftp://example.com/x",
      "javascript:alert(1)",
      "http://user:pass@example.com/",
      "http://127.0.0.1:3000/api/auth/status",
      "http://localhost/",
      "http://[::1]/",
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.5/",
      "http://service.internal/",
      "http://printer.local/",
      "http://2130706433/", // 127.0.0.1 as a decimal integer
      "http://0x7f.0.0.1/", // hex octet
      "not a url",
    ]) {
      await expect(assertPublicUrl(url, false), url).rejects.toBeInstanceOf(NetError);
    }
  });

  it("allows public literal addresses, and private ones only when opted in", async () => {
    await expect(assertPublicUrl("https://8.8.8.8/x", false)).resolves.toBeInstanceOf(URL);
    await expect(assertPublicUrl("http://127.0.0.1:8080/", true)).resolves.toBeInstanceOf(URL);
  });
});

describe("htmlToText", () => {
  it("drops scripts and tags and keeps readable text", () => {
    const text = htmlToText(`<html><head><title>t</title><style>p{}</style></head><body><script>alert(1)</script><h1>Title</h1><p>Hello &amp; <b>world</b></p><ul><li>one</li><li>two</li></ul></body></html>`);
    expect(text).toContain("Title");
    expect(text).toContain("Hello & world");
    expect(text).toContain("one");
    expect(text).not.toContain("alert");
    expect(text).not.toContain("<");
  });
});
