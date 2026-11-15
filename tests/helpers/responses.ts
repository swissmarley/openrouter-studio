import template from "../fixtures/response-template.json";
import { data } from "./mock-openrouter";

/**
 * Builders for Responses API streams, shaped after a real capture from OpenRouter
 * (tests/fixtures/response-template.json is the `response.completed` payload of one).
 */

let n = 0;

export interface Usage {
  input?: number;
  output?: number;
  cost?: number;
}

function completed(output: unknown[], usage: Usage) {
  const id = `gen-test-${++n}`;
  const response = {
    ...template,
    id,
    output,
    usage: {
      input_tokens: usage.input ?? 10,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: usage.output ?? 5,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: (usage.input ?? 10) + (usage.output ?? 5),
      cost: usage.cost ?? 0.001,
    },
  };
  return { id, response };
}

/** The model answers with text. */
export function textReply(text: string, usage: Usage = {}, opts: { delayMs?: number } = {}) {
  const item = { id: `msg_${n + 1}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [], logprobs: [] }] };
  const { id, response } = completed([item], usage);
  const created = { ...response, status: "in_progress", output: [], usage: null };
  return {
    delayMs: opts.delayMs,
    sse: [
      data({ type: "response.created", response: created, sequence_number: 0 }),
      data({ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] }, sequence_number: 1 }),
      data({ type: "response.content_part.added", output_index: 0, item_id: item.id, content_index: 0, part: { type: "output_text", text: "", annotations: [], logprobs: [] }, sequence_number: 2 }),
      data({ type: "response.output_text.delta", output_index: 0, item_id: item.id, content_index: 0, delta: text, logprobs: [], sequence_number: 3 }),
      data({ type: "response.output_text.done", output_index: 0, item_id: item.id, content_index: 0, text, logprobs: [], sequence_number: 4 }),
      data({ type: "response.output_item.done", output_index: 0, item, sequence_number: 5 }),
      data({ type: "response.completed", response: { ...response, id }, sequence_number: 6 }),
      data("[DONE]"),
    ],
  };
}

/** The model asks for one or more tool calls. */
export function toolReply(calls: { name: string; args: unknown; id?: string }[], usage: Usage = {}, opts: { delayMs?: number } = {}) {
  const items = calls.map((c, i) => ({
    id: `fc_${n + 1}_${i}`,
    type: "function_call",
    status: "completed",
    call_id: c.id ?? `call_${n + 1}_${i}`,
    name: c.name,
    arguments: JSON.stringify(c.args),
  }));
  const { id, response } = completed(items, usage);
  const created = { ...response, status: "in_progress", output: [], usage: null };
  const frames = [data({ type: "response.created", response: created, sequence_number: 0 })];
  let seq = 1;
  items.forEach((item, i) => {
    frames.push(data({ type: "response.output_item.added", output_index: i, item: { ...item, status: "in_progress", arguments: "" }, sequence_number: seq++ }));
    frames.push(data({ type: "response.function_call_arguments.delta", output_index: i, item_id: item.id, delta: item.arguments, sequence_number: seq++ }));
    frames.push(data({ type: "response.function_call_arguments.done", output_index: i, item_id: item.id, name: item.name, arguments: item.arguments, sequence_number: seq++ }));
    frames.push(data({ type: "response.output_item.done", output_index: i, item, sequence_number: seq++ }));
  });
  frames.push(data({ type: "response.completed", response: { ...response, id }, sequence_number: seq }), data("[DONE]"));
  return { delayMs: opts.delayMs, sse: frames };
}
