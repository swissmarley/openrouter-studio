import "server-only";
import { getQuickJS, type QuickJSContext, type QuickJSHandle, type QuickJSWASMModule } from "quickjs-emscripten";
import { env } from "../env";

/**
 * Sandboxed JavaScript execution.
 *
 * Model-written and user-written code never runs in this Node process. It runs in QuickJS
 * compiled to WebAssembly: a separate interpreter with its own heap, no `require`, no
 * `process`, no filesystem and no network. Each run gets a fresh runtime with a memory
 * cap and a deadline, and the only way out is the host functions we choose to expose
 * (console capture, and optionally a guarded `fetch`).
 */

export interface SandboxFetchResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface SandboxOptions {
  timeoutMs?: number;
  memoryMb?: number;
  /** Exposed to the code as the global `input`. Must be JSON-serializable. */
  input?: unknown;
  /** When provided, the sandbox gets a `fetch` that is routed through this function. */
  fetch?: (url: string, init: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<SandboxFetchResult>;
  signal?: AbortSignal;
  /**
   * "script": evaluate as a program; the value of the last expression is the result.
   * "function": treat the code as the body of `async (input) => { ... }`.
   */
  mode?: "script" | "function";
}

export interface SandboxResult {
  ok: boolean;
  /** JSON-compatible result value (undefined becomes null). */
  result: unknown;
  logs: string[];
  error: string | null;
  durationMs: number;
}

const MAX_LOG_CHARS = 20_000;
const MAX_RESULT_CHARS = 200_000;

let modulePromise: Promise<QuickJSWASMModule> | null = null;
const quickjs = () => (modulePromise ??= getQuickJS());

// Installed inside the VM. Turns the host's string-in/string-out bridge into a fetch-like API.
const FETCH_SHIM = `
globalThis.fetch = async (url, init) => {
  init = init || {};
  const raw = await __hostFetch(String(url), JSON.stringify({ method: init.method, headers: init.headers, body: typeof init.body === "string" ? init.body : init.body === undefined ? undefined : JSON.stringify(init.body) }));
  const res = JSON.parse(raw);
  if (res.error) throw new Error(res.error);
  return { status: res.status, ok: res.status >= 200 && res.status < 300, headers: res.headers, text: async () => res.body, json: async () => JSON.parse(res.body) };
};`;

const CONSOLE_SHIM = `
globalThis.console = Object.fromEntries(["log", "info", "warn", "error", "debug"].map((level) => [level, (...args) =>
  __hostLog(level, args.map((a) => { if (typeof a === "string") return a; try { return JSON.stringify(a); } catch { return String(a); } }).join(" "))]));`;

function describeError(vm: QuickJSContext, handle: QuickJSHandle): string {
  const dumped = vm.dump(handle);
  if (dumped && typeof dumped === "object") {
    const name = typeof dumped.name === "string" ? dumped.name : "Error";
    const message = typeof dumped.message === "string" ? dumped.message : JSON.stringify(dumped);
    // QuickJS reports an interrupted run as "InternalError: interrupted".
    if (message === "interrupted") return "Execution timed out.";
    return `${name}: ${message}`;
  }
  return String(dumped);
}

export async function runSandboxed(code: string, opts: SandboxOptions = {}): Promise<SandboxResult> {
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? env.sandboxTimeoutMs;
  const deadline = started + timeoutMs;
  const logs: string[] = [];
  let logChars = 0;
  const finish = (ok: boolean, result: unknown, error: string | null): SandboxResult => ({ ok, result, logs, error, durationMs: Date.now() - started });

  if (opts.signal?.aborted) return finish(false, null, "Cancelled.");

  const QuickJS = await quickjs();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit((opts.memoryMb ?? env.sandboxMemoryMb) * 1024 * 1024);
  runtime.setMaxStackSize(512 * 1024);
  // Polled by the interpreter: stops infinite loops at the deadline or on cancel.
  runtime.setInterruptHandler(() => Date.now() > deadline || opts.signal?.aborted === true);
  const vm = runtime.newContext();

  // Host work the VM is waiting on. All of it must settle before the VM is disposed.
  const pending = new Set<Promise<void>>();
  const hostAbort = new AbortController();
  let disposed = false;

  try {
    const logFn = vm.newFunction("__hostLog", (levelHandle, textHandle) => {
      const level = vm.getString(levelHandle);
      const text = vm.getString(textHandle);
      if (logChars < MAX_LOG_CHARS) {
        const line = `${level === "log" ? "" : `[${level}] `}${text}`.slice(0, MAX_LOG_CHARS - logChars);
        logChars += line.length;
        logs.push(line);
        if (logChars >= MAX_LOG_CHARS) logs.push("[log output truncated]");
      }
    });
    vm.setProp(vm.global, "__hostLog", logFn);
    logFn.dispose();
    vm.unwrapResult(vm.evalCode(CONSOLE_SHIM)).dispose();

    if (opts.fetch) {
      const hostFetch = opts.fetch;
      const fetchFn = vm.newFunction("__hostFetch", (urlHandle, initHandle) => {
        const url = vm.getString(urlHandle);
        const init = JSON.parse(vm.getString(initHandle));
        const deferred = vm.newPromise();
        const work = hostFetch(url, init)
          .then(
            (res) => JSON.stringify(res),
            (err: Error) => JSON.stringify({ error: err.message || "fetch failed" }),
          )
          .then((payload) => {
            if (disposed) return;
            const handle = vm.newString(payload);
            deferred.resolve(handle);
            handle.dispose();
            // Let the awaiting code inside the VM continue.
            runtime.executePendingJobs();
          });
        pending.add(work);
        void work.finally(() => pending.delete(work));
        return deferred.handle;
      });
      vm.setProp(vm.global, "__hostFetch", fetchFn);
      fetchFn.dispose();
      vm.unwrapResult(vm.evalCode(FETCH_SHIM)).dispose();
    }

    const inputHandle = vm.unwrapResult(vm.evalCode(`(${JSON.stringify(opts.input ?? null)})`));
    vm.setProp(vm.global, "input", inputHandle);
    inputHandle.dispose();

    const source = opts.mode === "function" ? `(async (input) => {\n${code}\n})(input)` : code;
    const evaluated = vm.evalCode(source, "sandbox.js");
    if (evaluated.error) {
      const message = describeError(vm, evaluated.error);
      evaluated.error.dispose();
      return finish(false, null, message);
    }

    // A returned promise (async IIFE, or function mode) is awaited, bounded by the deadline.
    let valueHandle = evaluated.value;
    const settled = vm.resolvePromise(valueHandle);
    runtime.executePendingJobs();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => hostAbort.abort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const outcome = await Promise.race([
      settled,
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), Math.max(0, deadline - Date.now()));
      }),
      new Promise<"cancelled">((resolve) => hostAbort.signal.addEventListener("abort", () => resolve("cancelled"), { once: true })),
    ]);
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
    valueHandle.dispose();

    if (outcome === "timeout") return finish(false, null, "Execution timed out.");
    if (outcome === "cancelled") return finish(false, null, "Cancelled.");
    if (outcome.error) {
      const message = describeError(vm, outcome.error);
      outcome.error.dispose();
      return finish(false, null, message);
    }
    valueHandle = outcome.value;

    // Serialize inside the VM so only a string ever crosses the boundary.
    vm.setProp(vm.global, "__result", valueHandle);
    valueHandle.dispose();
    const serialized = vm.evalCode(`(() => { const s = JSON.stringify(__result); return s === undefined ? "null" : s; })()`);
    if (serialized.error) {
      const message = describeError(vm, serialized.error);
      serialized.error.dispose();
      return finish(false, null, `Result is not JSON-serializable (${message}).`);
    }
    const json = vm.getString(serialized.value);
    serialized.value.dispose();
    if (json.length > MAX_RESULT_CHARS) return finish(false, null, `Result too large (${json.length} characters; limit ${MAX_RESULT_CHARS}).`);
    return finish(true, JSON.parse(json), null);
  } catch (err) {
    return finish(false, null, (err as Error).message || "Sandbox failure.");
  } finally {
    // Stop outstanding host work, wait for it to unwind, then free the interpreter.
    hostAbort.abort();
    await Promise.allSettled([...pending]);
    disposed = true;
    try {
      vm.dispose();
      runtime.dispose();
    } catch {
      // A VM torn down mid-await can report leaked handles; the WASM heap is discarded either way.
    }
  }
}
