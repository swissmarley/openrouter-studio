import { z } from "zod";

/** Evals: run the same inputs across several models and compare quality, cost and latency. */

export const evalRowSchema = z.object({
  input: z.string().trim().min(1).max(100_000),
  /** What a good answer is: compared by the scorer, or shown to the judge. */
  expected: z.string().max(100_000).optional(),
});
export type EvalRow = z.infer<typeof evalRowSchema>;

export const datasetInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  rows: z.array(evalRowSchema).min(1).max(200),
});

export const SCORERS = [
  { id: "none", label: "No scoring", needsExpected: false, help: "Just compare outputs, cost and latency." },
  { id: "exact", label: "Exact match", needsExpected: true, help: "Output equals the expected text (ignoring case and surrounding whitespace)." },
  { id: "contains", label: "Contains", needsExpected: true, help: "Output contains the expected text (ignoring case)." },
  { id: "regex", label: "Regex", needsExpected: true, help: "Output matches the expected regular expression." },
  { id: "json", label: "Valid JSON", needsExpected: false, help: "Output parses as JSON." },
  { id: "judge", label: "LLM judge", needsExpected: false, help: "Another model grades each answer from 0 to 10 against your rubric." },
] as const;
export type ScorerId = (typeof SCORERS)[number]["id"];

export const evalConfigSchema = z.object({
  name: z.string().trim().min(1).max(80),
  models: z.array(z.string().trim().min(1).max(200)).min(1).max(8),
  system: z.string().max(100_000).default(""),
  rows: z.array(evalRowSchema).min(1).max(200),
  scorer: z.enum(["none", "exact", "contains", "regex", "json", "judge"]).default("none"),
  judgeModel: z.string().trim().max(200).default(""),
  rubric: z.string().max(5000).default("Score how correct, complete and directly useful the answer is."),
  temperature: z.number().min(0).max(2).nullable().default(0),
  maxTokens: z.number().int().min(1).max(100_000).nullable().default(1024),
  concurrency: z.number().int().min(1).max(8).default(4),
});
export type EvalConfig = z.infer<typeof evalConfigSchema>;

export interface EvalResult {
  id: string;
  rowIndex: number;
  model: string;
  modelUsed: string | null;
  output: string | null;
  /** 0..1, or null when unscored. */
  score: number | null;
  scoreDetail: string | null;
  latencyMs: number | null;
  ttftMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  cost: number | null;
  judgeCost: number | null;
  error: string | null;
}

export interface EvalSummary {
  id: string;
  name: string;
  status: "running" | "completed" | "failed" | "cancelled";
  total: number;
  done: number;
  error: string | null;
  createdAt: number;
  endedAt: number | null;
  config: EvalConfig;
}

const normalize = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

/** Strips a Markdown code fence, which models often wrap JSON in. */
export function unfence(text: string): string {
  const match = text.trim().match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  return match ? match[1].trim() : text.trim();
}

/** Deterministic scorers. Returns null when the row cannot be scored (no expected value). */
export function scoreDeterministic(scorer: ScorerId, output: string, expected: string | undefined): { score: number; detail: string } | null {
  switch (scorer) {
    case "exact":
      if (expected === undefined) return null;
      return normalize(output) === normalize(expected) ? { score: 1, detail: "matches" } : { score: 0, detail: "differs from expected" };
    case "contains":
      if (expected === undefined) return null;
      return normalize(output).includes(normalize(expected)) ? { score: 1, detail: "contains expected" } : { score: 0, detail: "expected text not found" };
    case "regex": {
      if (expected === undefined) return null;
      try {
        return new RegExp(expected, "is").test(output) ? { score: 1, detail: "matches pattern" } : { score: 0, detail: "pattern not matched" };
      } catch {
        return { score: 0, detail: "expected is not a valid regular expression" };
      }
    }
    case "json":
      try {
        JSON.parse(unfence(output));
        return { score: 1, detail: "valid JSON" };
      } catch {
        return { score: 0, detail: "not valid JSON" };
      }
    default:
      return null;
  }
}

export interface ModelStats {
  model: string;
  done: number;
  errors: number;
  /** Mean score 0..1 over scored rows. */
  avgScore: number | null;
  scored: number;
  totalCost: number;
  judgeCost: number;
  avgLatencyMs: number | null;
  p95LatencyMs: number | null;
  avgTtftMs: number | null;
  promptTokens: number;
  completionTokens: number;
  /** Output tokens per second of generation, averaged. */
  tokensPerSec: number | null;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function summarize(models: string[], results: EvalResult[]): ModelStats[] {
  return models.map((model) => {
    const rows = results.filter((r) => r.model === model);
    const ok = rows.filter((r) => !r.error);
    const scores = ok.map((r) => r.score).filter((s): s is number => s !== null);
    const latencies = ok.map((r) => r.latencyMs).filter((v): v is number => v !== null).sort((a, b) => a - b);
    const ttfts = ok.map((r) => r.ttftMs).filter((v): v is number => v !== null);
    const speeds = ok
      .filter((r) => r.completionTokens && r.latencyMs !== null && r.ttftMs !== null && r.latencyMs > r.ttftMs)
      .map((r) => (r.completionTokens! / (r.latencyMs! - r.ttftMs!)) * 1000);
    return {
      model,
      done: rows.length,
      errors: rows.length - ok.length,
      avgScore: mean(scores),
      scored: scores.length,
      totalCost: rows.reduce((a, r) => a + (r.cost ?? 0), 0),
      judgeCost: rows.reduce((a, r) => a + (r.judgeCost ?? 0), 0),
      avgLatencyMs: mean(latencies),
      p95LatencyMs: latencies.length ? latencies[Math.min(latencies.length - 1, Math.ceil(0.95 * latencies.length) - 1)] : null,
      avgTtftMs: mean(ttfts),
      promptTokens: rows.reduce((a, r) => a + (r.promptTokens ?? 0), 0),
      completionTokens: rows.reduce((a, r) => a + (r.completionTokens ?? 0), 0),
      tokensPerSec: mean(speeds),
    };
  });
}

/** Parses a pasted dataset: JSON array, JSON Lines, or CSV with `input` and optional `expected` columns. */
export function parseDataset(text: string): EvalRow[] {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Paste some rows first.");
  const fromObjects = (items: unknown[]): EvalRow[] =>
    items.map((item, i) => {
      if (typeof item === "string") return { input: item };
      const o = item as Record<string, unknown>;
      const input = o?.input ?? o?.prompt ?? o?.question;
      if (typeof input !== "string" || !input.trim()) throw new Error(`Row ${i + 1} has no "input".`);
      const expected = o.expected ?? o.answer ?? o.output;
      return { input, ...(expected !== undefined && expected !== null ? { expected: typeof expected === "string" ? expected : JSON.stringify(expected) } : {}) };
    });

  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) throw new Error("Expected a JSON array.");
    return fromObjects(parsed);
  }
  if (trimmed.startsWith("{")) {
    return fromObjects(trimmed.split(/\r?\n/).filter((l) => l.trim()).map((l, i) => {
      try {
        return JSON.parse(l);
      } catch {
        throw new Error(`Line ${i + 1} is not valid JSON.`);
      }
    }));
  }

  // CSV, with quoted fields and "" escapes.
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let quoted = false;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (quoted) {
      if (ch === '"' && trimmed[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && trimmed[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  row.push(field);
  rows.push(row);

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const inputCol = header.findIndex((h) => ["input", "prompt", "question"].includes(h));
  if (inputCol === -1) {
    // No header: one prompt per line.
    return trimmed.split(/\r?\n/).filter((l) => l.trim()).map((l) => ({ input: l.trim() }));
  }
  const expectedCol = header.findIndex((h) => ["expected", "answer", "output"].includes(h));
  return rows
    .slice(1)
    .filter((r) => r[inputCol]?.trim())
    .map((r) => ({ input: r[inputCol], ...(expectedCol !== -1 && r[expectedCol] !== undefined && r[expectedCol] !== "" ? { expected: r[expectedCol] } : {}) }));
}
