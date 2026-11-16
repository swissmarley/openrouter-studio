import { describe, expect, it } from "vitest";
import { runSandboxed } from "@/lib/server/tools/sandbox";

describe("code sandbox", () => {
  it("returns the last expression and captures console output", async () => {
    const r = await runSandboxed(`console.log("hi", { a: 1 }); const xs = [1, 2, 3]; xs.map((x) => x * 2)`);
    expect(r).toMatchObject({ ok: true, result: [2, 4, 6], logs: ['hi {"a":1}'], error: null });
  });

  it("awaits a returned promise and exposes `input`", async () => {
    const r = await runSandboxed(`(async () => { await Promise.resolve(); return input.n + 1; })()`, { input: { n: 41 } });
    expect(r).toMatchObject({ ok: true, result: 42 });
  });

  it("runs function-mode code as an async function body", async () => {
    const r = await runSandboxed(`const total = input.items.reduce((a, b) => a + b, 0); return { total };`, { mode: "function", input: { items: [1, 2, 3] } });
    expect(r).toMatchObject({ ok: true, result: { total: 6 } });
  });

  it("has no access to Node: no process, require, fs, or host globals", async () => {
    const r = await runSandboxed(`({ process: typeof process, require: typeof require, fetch: typeof fetch, Buffer: typeof Buffer, globalKeys: Object.keys(globalThis).filter((k) => !k.startsWith("__")).sort() })`);
    expect(r.ok).toBe(true);
    expect(r.result).toMatchObject({ process: "undefined", require: "undefined", fetch: "undefined", Buffer: "undefined" });
    await expect(runSandboxed(`require("fs").readFileSync("/etc/passwd", "utf8")`)).resolves.toMatchObject({ ok: false });
    await expect(runSandboxed(`import("node:fs")`)).resolves.toMatchObject({ ok: false });
  });

  it("cannot reach the host through constructor tricks", async () => {
    // The classic vm-escape: climb to the Function constructor and ask for the host's process.
    const r = await runSandboxed(`(() => { try { return typeof console.log.constructor("return process")(); } catch (e) { return "threw: " + e.message; } })()`);
    expect(r.ok).toBe(true);
    expect(r.result === "undefined" || String(r.result).startsWith("threw")).toBe(true);
  });

  it("stops an infinite loop at the deadline", async () => {
    const r = await runSandboxed(`while (true) {}`, { timeoutMs: 200 });
    expect(r).toMatchObject({ ok: false, error: "Execution timed out." });
    expect(r.durationMs).toBeLessThan(2000);
  });

  it("stops a promise that never settles", async () => {
    const r = await runSandboxed(`new Promise(() => {})`, { timeoutMs: 150 });
    expect(r).toMatchObject({ ok: false, error: "Execution timed out." });
  });

  it("enforces the memory limit", async () => {
    const r = await runSandboxed(`const a = []; while (true) a.push("x".repeat(1024 * 1024));`, { memoryMb: 8, timeoutMs: 3000 });
    expect(r.ok).toBe(false);
    expect(r.error).not.toBeNull();
  });

  it("reports thrown errors and syntax errors", async () => {
    await expect(runSandboxed(`throw new TypeError("nope")`)).resolves.toMatchObject({ ok: false, error: "TypeError: nope" });
    const syntax = await runSandboxed(`let = ;`);
    expect(syntax.ok).toBe(false);
    expect(syntax.error).toMatch(/SyntaxError/);
  });

  it("only gets network access through the bridge it is given", async () => {
    const calls: string[] = [];
    const r = await runSandboxed(
      `const res = await fetch("https://example.test/data", { method: "POST", body: { q: 1 } }); const j = await res.json(); return { status: res.status, ok: res.ok, echoed: j };`,
      {
        mode: "function",
        fetch: async (url, init) => {
          calls.push(`${init.method} ${url} ${init.body}`);
          return { status: 200, headers: {}, body: JSON.stringify({ hello: "world" }) };
        },
      },
    );
    expect(r).toMatchObject({ ok: true, result: { status: 200, ok: true, echoed: { hello: "world" } } });
    expect(calls).toEqual(['POST https://example.test/data {"q":1}']);
  });

  it("surfaces bridge failures as catchable errors", async () => {
    const r = await runSandboxed(`try { await fetch("https://blocked.test"); return "reached"; } catch (e) { return "caught: " + e.message; }`, {
      mode: "function",
      fetch: async () => {
        throw new Error("blocked by policy");
      },
    });
    expect(r).toMatchObject({ ok: true, result: "caught: blocked by policy" });
  });

  it("honors cancellation", async () => {
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 50);
    const r = await runSandboxed(`new Promise(() => {})`, { timeoutMs: 5000, signal: abort.signal });
    expect(r).toMatchObject({ ok: false, error: "Cancelled." });
    expect(r.durationMs).toBeLessThan(2000);
  });

  it("isolates runs from each other", async () => {
    await runSandboxed(`globalThis.leak = 123`);
    await expect(runSandboxed(`typeof leak`)).resolves.toMatchObject({ result: "undefined" });
  });
});
