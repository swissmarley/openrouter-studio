# OpenRouter Studio

One UI and one agent harness for the whole [OpenRouter](https://openrouter.ai) platform: explore models, chat with several at once, build tool-using agents, run evals, and watch spend.

Next.js 16 · TypeScript · Tailwind 4 · SQLite (Drizzle) · the official `@openrouter/agent` SDK.

## Quick start

```bash
npm install
cp .env.example .env.local      # optional for local development
npm run dev                     # http://localhost:3000
```

Open the app and paste an OpenRouter API key (create one at <https://openrouter.ai/keys>; giving it a credit limit is a good idea), or use **Sign in with OpenRouter** (OAuth PKCE). No other setup is needed: the SQLite database is created and migrated on first use.

Production: set `APP_SECRET` and `APP_URL`, then `npm run build && npm start`. Keep `DATA_DIR` on a persistent volume.

## What is in it

| Area | What you get |
|---|---|
| **Models** | The live catalog with filters for price, context length, input/output modalities and supported parameters (tools, structured output, reasoning…). Per-provider endpoint detail (price, latency, throughput, uptime) and a side-by-side compare of up to four models. |
| **Chat** | Streaming (SSE) over both `/chat/completions` and `/responses`. Up to four models side by side, system prompt, sampling parameters, reasoning controls, JSON object / JSON-schema output, image / PDF / audio input, and tokens, cost, latency and time-to-first-token on every message. |
| **Routing** | Fallback model lists, `openrouter/auto` with allowed models, `:nitro` / `:floor`, provider order / only / ignore, sort by price / latency / throughput, price ceilings, quantization, and data-policy filters (`data_collection`, ZDR). Available in chat, agents and evals. |
| **Agents** | Name, model, system prompt, tool selection, max steps, per-run budget cap, sampling, routing. Multi-turn loop with a live step-by-step trace, human approval for sensitive tools, pause / resume / cancel, sub-agents, handoffs, saved runs you can replay or re-run. |
| **Tools** | Built-in: web fetch, HTTP request, code sandbox, file read / write / list. Custom: a Zod schema plus a JavaScript function. MCP: remote servers over Streamable HTTP or SSE. Every call is rate limited and audit-logged. |
| **Evals** | One prompt or a dataset (JSON / JSONL / CSV) across up to 8 models. Scorers: exact, contains, regex, valid JSON, or an LLM judge. Compares quality, cost, latency, first-token time and throughput. |
| **Dashboard & logs** | Key and credit balances from OpenRouter, spend from the app's own log (by day, model and feature), latency percentiles, failure and retry counts, and a searchable request log. |
| **Settings** | Daily / monthly budgets with alert thresholds and an optional hard stop, default models, tool rate limit, agent import / export as JSON. |

Keyboard: `⌘/Ctrl K` command palette, `g` then `m c a r t e d l s` to jump between pages, `/` to focus search, `?` for the full list, `Esc` to stop a generation, `Enter` to send.

## Example agents

**Settings → Import**, or **Agents → Add examples**, installs the agents in [`examples/agents.json`](examples/agents.json):

- **Researcher**: reads sources with `web_fetch`, cites what it used, can delegate arithmetic to the Data Analyst. File writes ask for approval.
- **Coder**: writes JavaScript and *runs it in the sandbox* before presenting it. File writes ask for approval.
- **Data Analyst**: uses a custom `csv_summary` tool and the sandbox instead of mental arithmetic.
- **Concierge**: a router that hands the task off to one of the three above.

## How it works

```
Browser ──► Next.js route handlers (Zod-validated) ──► openrouter.ai/api/v1
                │
                ├─ encrypted key, httpOnly session cookie, same-origin check on writes
                ├─ retry/backoff (408/429/5xx, Retry-After), request log, budget check
                └─ SQLite (Drizzle): accounts, agents, runs + event log, tool calls, evals, logs
```

- **The browser never sees the key.** Keys are sealed with AES-256-GCM using `APP_SECRET` and decrypted only inside a request. The UI shows a hint (`sk-or-v1…abcd`). Every OpenRouter call, including the model list, goes through the server proxy.
- **One retry policy.** Chat, evals and the Agent SDK's HTTP all share it: 408 / 429 / 5xx and network errors retry with exponential backoff and jitter, honoring `Retry-After`. Retries are counted in the log.
- **Agent loop = the Agent SDK.** Tools are `tool()` definitions with Zod input schemas; bounds are `stopWhen` conditions (`stepCountIs`, `maxCost`); approvals use the SDK's `requireApproval` with persisted conversation state, so a run waiting for approval survives a server restart. Runs execute detached from HTTP requests and append to a stored event log, which is streamed live over SSE and replayed from the same log.
- **Budgets** are measured from the app's own request log (UTC day / month). They cap what *this app* spends; for a limit that also covers other apps, set a credit limit on the key itself.

### Safety model for tools

- **Code never runs in the Node process.** `run_javascript` and custom tool bodies run in QuickJS compiled to WebAssembly: fresh runtime per call, memory cap, deadline, no `require` / `process` / filesystem / network. A custom tool may be granted a `fetch` that goes through the guard below.
- **Custom tool schemas are parsed, not evaluated.** The Zod source is parsed to an AST and walked against an allow-list. Functions (`.refine`, `.transform`), identifiers other than `z`, computed access and spreads are rejected.
- **Model-chosen URLs can't reach your network.** `web_fetch`, `http_request` and sandbox `fetch` allow only http(s), block private / loopback / link-local / metadata addresses (checked after DNS and again on every redirect hop), and cap time and response size. `TOOLS_ALLOW_PRIVATE_NETWORK=true` lifts this deliberately.
- **File tools are confined** to a per-account workspace under `DATA_DIR/workspaces/`; absolute paths, `..` and escaping symlinks are refused.
- **Every tool call** passes one guard: pause gate → per-account rate limit → deadline → result size cap → audit-log row. Failures are returned to the model as `{ error }` instead of ending the run.
- **MCP credentials are write-only**: encrypted at rest, never returned by the API, never included in exports.

## Scripts

| | |
|---|---|
| `npm run dev` / `build` / `start` | Run the app |
| `npm test` | Unit and integration tests (Vitest) |
| `npm run typecheck` · `npm run lint` | Static checks |
| `npm run db:generate` | Generate a Drizzle migration after editing `src/db/schema.ts` |

The tests include a scriptable mock of the OpenRouter API (`tests/helpers/`), used to cover failures that can't be produced on demand against the real service: 429 / 5xx retries, mid-stream errors, aborts, approval flows, restarts, budgets. Agent stream fixtures are shaped after real captures.

## Limitations

- **Single-user / single-process.** Accounts are keyed by API key; there are no roles. Live run state is in memory (persisted state lets approvals survive restarts, but an in-flight model call does not). Don't run several server instances against one database.
- **`/activity` and `/credits`** need a management key; with a regular key the dashboard shows the key's own usage and the app's log, and says what's unavailable.
- **MCP over stdio** isn't supported (remote servers only), and MCP OAuth isn't wired into the UI (bearer token or custom headers).
- **Agent SDK status.** `@openrouter/agent` is pinned (currently beta upstream). Check its changelog before upgrading.
- **Audio** goes to models that accept audio input; OpenRouter does not accept audio URLs, so files are sent as base64 (15 MB limit per file in the UI).

## Project layout

```
src/app/            pages and API route handlers
src/components/     UI (ui.tsx is the small component kit)
src/lib/shared/     schemas and helpers used by both server and browser (Zod)
src/lib/server/     proxy client, sessions, agents/runner, tools/, evals, usage
src/db/             Drizzle schema (migrations in /drizzle)
examples/           example agent bundle
tests/              Vitest suites and the mock upstream
```

MIT licensed.
