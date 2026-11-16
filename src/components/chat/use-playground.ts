"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiClientError } from "@/lib/client/api";
import { postSse } from "@/lib/client/sse";
import type {
  ChatMessageInput,
  ChatRequestInput,
  ChatStreamEvent,
  ChatUsage,
  ContentPart,
  ReasoningConfig,
  Sampling,
} from "@/lib/shared/chat";
import { defaultRouting, type Routing } from "@/lib/shared/routing";

export interface Attachment {
  id: string;
  name: string;
  size: number;
  part: ContentPart;
}

export interface Turn {
  id: string;
  role: "user" | "assistant";
  text: string;
  attachments?: Attachment[];
  reasoning?: string;
  usage?: ChatUsage;
  error?: string;
  streaming?: boolean;
  stopped?: boolean;
}

export interface Pane {
  id: string;
  model: string;
  turns: Turn[];
}

export interface PlaygroundConfig {
  api: "chat" | "responses";
  system: string;
  sampling: Sampling;
  reasoning: ReasoningConfig;
  format: "text" | "json_object" | "json_schema";
  schemaName: string;
  schemaText: string;
  schemaStrict: boolean;
  routing: Routing;
  pdfEngine: "auto" | "native" | "mistral-ocr" | "cloudflare-ai";
}

export const defaultConfig: PlaygroundConfig = {
  api: "chat",
  system: "",
  sampling: { temperature: null, topP: null, topK: null, maxTokens: null, frequencyPenalty: null, presencePenalty: null, seed: null, stop: [] },
  reasoning: { mode: "default", effort: null, maxTokens: null, exclude: false },
  format: "text",
  schemaName: "result",
  schemaText: JSON.stringify(
    { type: "object", properties: { answer: { type: "string" }, confidence: { type: "number" } }, required: ["answer", "confidence"], additionalProperties: false },
    null,
    2,
  ),
  schemaStrict: true,
  routing: defaultRouting,
  pdfEngine: "auto",
};

const STORAGE_KEY = "ors-chat-v1";
export const MAX_PANES = 4;

let counter = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${(counter++).toString(36)}`;

function loadStored(): { config: PlaygroundConfig; models: string[] } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return {
      // Merge over defaults so a config saved by an older build still has every field.
      config: {
        ...defaultConfig,
        ...parsed.config,
        sampling: { ...defaultConfig.sampling, ...parsed.config?.sampling },
        reasoning: { ...defaultConfig.reasoning, ...parsed.config?.reasoning },
        routing: { ...defaultRouting, ...parsed.config?.routing, provider: { ...defaultRouting.provider, ...parsed.config?.routing?.provider } },
      },
      models: Array.isArray(parsed.models) ? parsed.models.filter((m: unknown) => typeof m === "string").slice(0, MAX_PANES) : [],
    };
  } catch {
    return null;
  }
}

/** Turns a conversation into the message list the API expects, skipping failed replies. */
function toMessages(turns: Turn[]): ChatMessageInput[] {
  const out: ChatMessageInput[] = [];
  for (const t of turns) {
    if (t.role === "assistant") {
      if (t.text) out.push({ role: "assistant", content: t.text });
      continue;
    }
    if (t.attachments?.length) {
      out.push({ role: "user", content: [...(t.text ? [{ type: "text" as const, text: t.text }] : []), ...t.attachments.map((a) => a.part)] });
    } else {
      out.push({ role: "user", content: t.text });
    }
  }
  return out;
}

/**
 * Playground state. The component using this only mounts in the browser (behind the
 * session check), so the remembered settings can be read in the state initializers.
 */
export function usePlayground(initialModel: string) {
  const [stored] = useState(loadStored);
  const [config, setConfig] = useState<PlaygroundConfig>(stored?.config ?? defaultConfig);
  const [panes, setPanes] = useState<Pane[]>(() =>
    // A model passed in the URL wins over the remembered layout.
    !initialModel && stored?.models.length
      ? stored.models.map((model, i) => ({ id: `pane-${i}`, model, turns: [] }))
      : [{ id: "pane-0", model: initialModel, turns: [] }],
  );
  const [formError, setFormError] = useState<string | null>(null);
  const controllers = useRef(new Map<string, AbortController>());
  // `send` reads the latest panes without being recreated on every streamed token.
  const panesRef = useRef(panes);
  useEffect(() => {
    panesRef.current = panes;
  }, [panes]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ config, models: panes.map((p) => p.model) }));
    } catch {
      /* quota or disabled storage: settings just won't persist */
    }
    // Only the model list matters for persistence, not every streamed token.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, panes.map((p) => p.model).join("|")]);

  const patchTurn = useCallback((paneId: string, turnId: string, patch: (t: Turn) => Turn) => {
    setPanes((cur) => cur.map((p) => (p.id === paneId ? { ...p, turns: p.turns.map((t) => (t.id === turnId ? patch(t) : t)) } : p)));
  }, []);

  const busy = panes.some((p) => p.turns.some((t) => t.streaming));

  const stop = useCallback(() => {
    controllers.current.forEach((c) => c.abort());
    controllers.current.clear();
  }, []);

  const send = useCallback(
    (text: string, attachments: Attachment[]): boolean => {
      setFormError(null);
      let responseFormat: ChatRequestInput["responseFormat"] = { type: "text" };
      if (config.format === "json_object") responseFormat = { type: "json_object" };
      if (config.format === "json_schema") {
        try {
          const schema = JSON.parse(config.schemaText);
          if (typeof schema !== "object" || schema === null || Array.isArray(schema)) throw new Error("The schema must be a JSON object.");
          responseFormat = { type: "json_schema", name: config.schemaName, strict: config.schemaStrict, schema };
        } catch (err) {
          setFormError(`JSON schema is invalid: ${(err as Error).message}`);
          return false;
        }
      }

      const userTurn: Turn = { id: uid("u"), role: "user", text, attachments: attachments.length ? attachments : undefined };
      for (const pane of panesRef.current) {
        if (!pane.model) continue;
        const replyId = uid("a");
        const history = [...pane.turns, userTurn];
        setPanes((cur) =>
          cur.map((p) => (p.id === pane.id ? { ...p, turns: [...history, { id: replyId, role: "assistant", text: "", streaming: true }] } : p)),
        );

        const controller = new AbortController();
        controllers.current.set(pane.id, controller);
        const request: ChatRequestInput = {
          api: config.api,
          model: pane.model,
          system: config.system,
          messages: toMessages(history),
          sampling: config.sampling,
          reasoning: config.reasoning,
          responseFormat,
          routing: config.routing,
          pdfEngine: config.pdfEngine,
        };

        postSse<ChatStreamEvent>(
          "/api/chat",
          request,
          (event) => {
            if (event.type === "delta") patchTurn(pane.id, replyId, (t) => ({ ...t, text: t.text + event.text }));
            else if (event.type === "reasoning") patchTurn(pane.id, replyId, (t) => ({ ...t, reasoning: (t.reasoning ?? "") + event.text }));
            else if (event.type === "usage") patchTurn(pane.id, replyId, (t) => ({ ...t, usage: event.usage }));
            else if (event.type === "error") patchTurn(pane.id, replyId, (t) => ({ ...t, error: event.message }));
          },
          controller.signal,
        )
          .catch((err: unknown) => {
            if (controller.signal.aborted) {
              patchTurn(pane.id, replyId, (t) => ({ ...t, stopped: true }));
            } else {
              const message = err instanceof ApiClientError ? err.message : "The connection was lost before the reply finished.";
              patchTurn(pane.id, replyId, (t) => ({ ...t, error: message }));
            }
          })
          .finally(() => {
            patchTurn(pane.id, replyId, (t) => ({ ...t, streaming: false }));
            if (controllers.current.get(pane.id) === controller) controllers.current.delete(pane.id);
          });
      }
      return true;
    },
    [config, patchTurn],
  );

  return {
    config,
    setConfig,
    panes,
    busy,
    formError,
    send,
    stop,
    setModel: (paneId: string, model: string) => setPanes((cur) => cur.map((p) => (p.id === paneId ? { ...p, model } : p))),
    addPane: (model: string) => setPanes((cur) => (cur.length >= MAX_PANES ? cur : [...cur, { id: uid("pane"), model, turns: [] }])),
    removePane: (paneId: string) => {
      controllers.current.get(paneId)?.abort();
      setPanes((cur) => (cur.length > 1 ? cur.filter((p) => p.id !== paneId) : cur));
    },
    clear: () => {
      stop();
      setPanes((cur) => cur.map((p) => ({ ...p, turns: [] })));
    },
  };
}
