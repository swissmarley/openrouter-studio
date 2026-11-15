"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AlertTriangle, AudioLines, Check, Copy, FileText, ImageIcon, Paperclip, Plus, Send, SlidersHorizontal, Square, Trash2, X } from "lucide-react";
import { useResource } from "@/lib/client/api";
import { useModels } from "@/lib/client/models";
import type { ChatUsage, ContentPart } from "@/lib/shared/chat";
import { cx, duration, tokens, usd } from "@/lib/shared/format";
import type { ModelInfo } from "@/lib/shared/models";
import { withVariant } from "@/lib/shared/routing";
import type { Settings } from "@/lib/shared/settings";
import { Markdown } from "../markdown";
import { ModelPicker } from "../model-picker";
import { Badge, Button, Notice, PageHeader } from "../ui";
import { SettingsPanel } from "./settings-panel";
import { MAX_PANES, usePlayground, type Attachment, type Pane, type Turn } from "./use-playground";

const FALLBACK_MODEL = "~anthropic/claude-haiku-latest";
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const AUDIO_FORMATS = ["wav", "mp3", "aiff", "aac", "ogg", "flac", "m4a"] as const;

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the file."));
    reader.readAsDataURL(file);
  });
}

/** Maps a picked file onto the content-part shape OpenRouter expects for its type. */
async function toAttachment(file: File): Promise<Attachment> {
  if (file.size > MAX_FILE_BYTES) throw new Error(`${file.name} is larger than 15 MB.`);
  const dataUrl = await readAsDataUrl(file);
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  let part: ContentPart;
  if (file.type.startsWith("image/")) {
    part = { type: "image", url: dataUrl };
  } else if (file.type.startsWith("audio/") || (AUDIO_FORMATS as readonly string[]).includes(ext)) {
    const format = (AUDIO_FORMATS as readonly string[]).includes(ext) ? (ext as (typeof AUDIO_FORMATS)[number]) : file.type.includes("mpeg") ? "mp3" : "wav";
    // Audio is sent as bare base64 (no data: prefix) plus an explicit format.
    part = { type: "audio", data: dataUrl.slice(dataUrl.indexOf(",") + 1), format };
  } else if (file.type === "application/pdf" || ext === "pdf") {
    part = { type: "file", filename: file.name, data: dataUrl };
  } else {
    throw new Error(`${file.name}: only images, PDFs and audio files can be attached.`);
  }
  return { id: `${file.name}-${file.size}-${file.lastModified}`, name: file.name, size: file.size, part };
}

function AttachmentChip({ a, onRemove }: { a: Attachment; onRemove?: () => void }) {
  const Icon = a.part.type === "image" ? ImageIcon : a.part.type === "audio" ? AudioLines : FileText;
  return (
    <span className="inline-flex max-w-52 items-center gap-1.5 rounded-md border border-line bg-subtle px-1.5 py-1 text-xs">
      {a.part.type === "image" ? (
        // eslint-disable-next-line @next/next/no-img-element -- a local data URL preview; next/image adds nothing here
        <img src={a.part.url} alt="" className="size-5 rounded object-cover" />
      ) : (
        <Icon className="size-3.5 text-muted" aria-hidden />
      )}
      <span className="truncate">{a.name}</span>
      <span className="tabular shrink-0 text-faint">{Math.max(1, Math.round(a.size / 1024))}KB</span>
      {onRemove ? (
        <button type="button" aria-label={`Remove ${a.name}`} onClick={onRemove} className="rounded text-faint hover:bg-hover hover:text-fg">
          <X className="size-3" />
        </button>
      ) : null}
    </span>
  );
}

function UsageLine({ usage, requested }: { usage: ChatUsage; requested: string }) {
  const tps = usage.completionTokens && usage.ttftMs !== null && usage.latencyMs > usage.ttftMs ? (usage.completionTokens / (usage.latencyMs - usage.ttftMs)) * 1000 : null;
  const rerouted = usage.model && usage.model !== requested.replace(/^~/, "") && !requested.startsWith("~");
  const items: (string | null)[] = [
    usage.promptTokens !== null ? `${tokens(usage.promptTokens)} in → ${tokens(usage.completionTokens)} out` : null,
    usage.reasoningTokens ? `${tokens(usage.reasoningTokens)} reasoning` : null,
    usage.cachedTokens ? `${tokens(usage.cachedTokens)} cached` : null,
    usage.cost !== null ? usd(usage.cost) : null,
    duration(usage.latencyMs),
    usage.ttftMs !== null ? `first token ${duration(usage.ttftMs)}` : null,
    tps ? `${Math.round(tps)} tok/s` : null,
    usage.provider ? `via ${usage.provider}` : null,
    usage.retries ? `${usage.retries} retr${usage.retries === 1 ? "y" : "ies"}` : null,
    usage.finishReason && usage.finishReason !== "stop" ? `finish: ${usage.finishReason}` : null,
  ];
  return (
    <p className="tabular mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-faint">
      {rerouted ? <Badge tone="accent" title="A different model answered (fallback or router)">{usage.model}</Badge> : null}
      {items.filter(Boolean).map((item, i) => (
        <span key={i}>{item}</span>
      ))}
    </p>
  );
}

function JsonOutput({ text }: { text: string }) {
  let pretty: string | null = null;
  try {
    pretty = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    /* not (yet) valid JSON */
  }
  return (
    <div>
      <Badge tone={pretty ? "ok" : "warn"}>{pretty ? "valid JSON" : "not valid JSON"}</Badge>
      <pre className="mt-1.5 overflow-x-auto rounded-md border border-line bg-subtle p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">{pretty ?? text}</pre>
    </div>
  );
}

function Message({ turn, requested, json }: { turn: Turn; requested: string; json: boolean }) {
  const [copied, setCopied] = useState(false);
  if (turn.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-lg bg-accent-soft px-3 py-2 text-[13px] text-fg">
          {turn.text ? <p className="whitespace-pre-wrap">{turn.text}</p> : null}
          {turn.attachments?.length ? (
            <div className={cx("flex flex-wrap gap-1", turn.text && "mt-1.5")}>
              {turn.attachments.map((a) => (
                <AttachmentChip key={a.id} a={a} />
              ))}
            </div>
          ) : null}
        </div>
      </div>
    );
  }
  const waiting = turn.streaming && !turn.text && !turn.reasoning;
  return (
    <div className="group">
      {turn.reasoning ? (
        <details className="mb-2 rounded-md border border-line bg-subtle" open={turn.streaming && !turn.text}>
          <summary className="cursor-pointer px-2.5 py-1.5 text-xs text-muted select-none">Reasoning</summary>
          <p className="max-h-60 overflow-y-auto px-2.5 pb-2 text-xs leading-relaxed whitespace-pre-wrap text-muted">{turn.reasoning}</p>
        </details>
      ) : null}
      {waiting ? <p className="caret text-[13px] text-faint">Waiting for the first token</p> : null}
      {turn.text ? (
        json && !turn.streaming ? (
          <JsonOutput text={turn.text} />
        ) : (
          <div className={turn.streaming ? "caret" : undefined}>
            <Markdown text={turn.text} />
          </div>
        )
      ) : null}
      {turn.error ? (
        <Notice tone="err" className="mt-1.5 flex items-start gap-2">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>{turn.error}</span>
        </Notice>
      ) : null}
      {turn.stopped ? <p className="mt-1 text-[11px] text-faint">Stopped.</p> : null}
      {turn.usage ? <UsageLine usage={turn.usage} requested={requested} /> : null}
      {turn.text && !turn.streaming ? (
        <button
          type="button"
          onClick={async () => {
            await navigator.clipboard.writeText(turn.text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
          className="mt-1 inline-flex items-center gap-1 rounded px-1 text-[11px] text-faint opacity-0 group-hover:opacity-100 hover:text-fg focus-visible:opacity-100"
        >
          {copied ? <Check className="size-3 text-ok" /> : <Copy className="size-3" />} Copy
        </button>
      ) : null}
    </div>
  );
}

/** Flags attachments or settings the selected model is not listed as supporting. */
function capabilityWarnings(model: ModelInfo | undefined, pending: Attachment[], pane: Pane, format: string): string[] {
  if (!model) return [];
  const kinds = new Set([...pending, ...pane.turns.flatMap((t) => t.attachments ?? [])].map((a) => a.part.type));
  const out: string[] = [];
  if (kinds.has("image") && !model.inputModalities.includes("image")) out.push("no image input");
  if (kinds.has("audio") && !model.inputModalities.includes("audio")) out.push("no audio input");
  if (format === "json_schema" && !model.supportedParameters.includes("structured_outputs")) out.push("no structured output");
  return out;
}

function PaneView({
  pane,
  model,
  variant,
  json,
  warnings,
  canRemove,
  onModel,
  onRemove,
}: {
  pane: Pane;
  model: ModelInfo | undefined;
  variant: "none" | "nitro" | "floor";
  json: boolean;
  warnings: string[];
  canRemove: boolean;
  onModel: (id: string) => void;
  onRemove: () => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const last = pane.turns[pane.turns.length - 1];

  // Follow the stream, unless the reader has scrolled up to look at something.
  useEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [last?.text, last?.reasoning, pane.turns.length]);

  const totals = useMemo(() => {
    let cost = 0;
    let inTok = 0;
    let outTok = 0;
    for (const t of pane.turns) {
      cost += t.usage?.cost ?? 0;
      inTok += t.usage?.promptTokens ?? 0;
      outTok += t.usage?.completionTokens ?? 0;
    }
    return { cost, inTok, outTok };
  }, [pane.turns]);

  return (
    <section aria-label={`Conversation with ${pane.model || "no model"}`} className="flex min-w-[20rem] flex-1 flex-col border-r border-line last:border-r-0">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <ModelPicker value={pane.model} onChange={onModel} className="flex-1" />
        {variant !== "none" ? <Badge tone="accent">:{variant}</Badge> : null}
        {canRemove ? (
          <button type="button" aria-label="Remove this model" onClick={onRemove} className="rounded p-1 text-faint hover:bg-hover hover:text-fg">
            <X className="size-4" />
          </button>
        ) : null}
      </div>
      {warnings.length ? (
        <div className="flex flex-wrap gap-1 border-b border-line bg-warn-soft px-3 py-1 text-[11px] text-warn">
          {model?.name} lists: {warnings.join(", ")}
        </div>
      ) : null}
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
        className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4"
      >
        {pane.turns.length === 0 ? (
          <p className="pt-10 text-center text-[13px] text-faint">
            {pane.model ? "Send a message to start." : "Pick a model above."}
          </p>
        ) : (
          pane.turns.map((t) => <Message key={t.id} turn={t} requested={withVariant(pane.model, variant)} json={json} />)
        )}
      </div>
      {totals.inTok + totals.outTok > 0 ? (
        <p className="tabular border-t border-line px-4 py-1.5 text-[11px] text-faint">
          Conversation total: {tokens(totals.inTok)} in · {tokens(totals.outTok)} out · {usd(totals.cost)}
        </p>
      ) : null}
    </section>
  );
}

export function Playground() {
  const params = useSearchParams();
  const { data: settingsData } = useResource<{ settings: Settings }>("/api/settings");
  const { models } = useModels();
  const pg = usePlayground(params.get("model") ?? "");
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<Attachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(true);
  const fileInput = useRef<HTMLInputElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);

  // Fill an empty first pane from the user's default once settings arrive.
  const defaultModel = settingsData?.settings.defaults.chatModel ?? null;
  useEffect(() => {
    if (!defaultModel) return;
    if (pg.panes.length === 1 && !pg.panes[0].model) pg.setModel(pg.panes[0].id, defaultModel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultModel]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && pg.busy && !document.querySelector("dialog[open]")) pg.stop();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pg]);

  async function addFiles(files: FileList | File[]) {
    setAttachError(null);
    for (const file of Array.from(files)) {
      try {
        const attachment = await toAttachment(file);
        setPending((cur) => (cur.some((a) => a.id === attachment.id) ? cur : [...cur, attachment]));
      } catch (err) {
        setAttachError((err as Error).message);
      }
    }
  }

  function submit() {
    const text = draft.trim();
    if ((!text && pending.length === 0) || pg.busy) return;
    if (!pg.panes.some((p) => p.model)) return;
    if (pg.send(text, pending)) {
      setDraft("");
      setPending([]);
    }
  }

  const json = pg.config.format !== "text";
  const anyModel = pg.panes.some((p) => p.model);

  return (
    <>
      <PageHeader
        title="Chat"
        description="Stream from up to four models side by side. Every request goes through this server; your key stays there."
        actions={
          <>
            <Button
              icon={<Plus className="size-3.5" />}
              disabled={pg.panes.length >= MAX_PANES}
              onClick={() => pg.addPane(pg.panes[pg.panes.length - 1]?.model || defaultModel || FALLBACK_MODEL)}
            >
              Add model
            </Button>
            <Button icon={<Trash2 className="size-3.5" />} onClick={pg.clear} disabled={!pg.panes.some((p) => p.turns.length)}>
              Clear
            </Button>
            <Button
              icon={<SlidersHorizontal className="size-3.5" />}
              aria-pressed={showSettings}
              onClick={() => setShowSettings((v) => !v)}
            >
              Settings
            </Button>
          </>
        }
      />
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 overflow-x-auto">
            {pg.panes.map((pane) => (
              <PaneView
                key={pane.id}
                pane={pane}
                model={models.find((m) => m.id === pane.model)}
                variant={pg.config.routing.variant}
                json={json}
                warnings={capabilityWarnings(models.find((m) => m.id === pane.model), pending, pane, pg.config.format)}
                canRemove={pg.panes.length > 1}
                onModel={(id) => pg.setModel(pane.id, id)}
                onRemove={() => pg.removePane(pane.id)}
              />
            ))}
          </div>

          <div
            className="border-t border-line bg-panel px-4 py-3"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files);
            }}
          >
            {pg.formError ? <Notice tone="err" className="mb-2">{pg.formError}</Notice> : null}
            {attachError ? <Notice tone="warn" className="mb-2">{attachError}</Notice> : null}
            {pending.length ? (
              <div className="mb-2 flex flex-wrap gap-1.5">
                {pending.map((a) => (
                  <AttachmentChip key={a.id} a={a} onRemove={() => setPending((cur) => cur.filter((x) => x.id !== a.id))} />
                ))}
              </div>
            ) : null}
            <div className="flex items-end gap-2">
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                accept="image/*,application/pdf,audio/*,.wav,.mp3,.m4a,.flac,.ogg"
                onChange={(e) => {
                  if (e.target.files?.length) void addFiles(e.target.files);
                  e.target.value = "";
                }}
              />
              <Button aria-label="Attach an image, PDF or audio file" icon={<Paperclip className="size-3.5" />} onClick={() => fileInput.current?.click()} />
              <textarea
                ref={composer}
                data-page-search
                aria-label="Message"
                rows={Math.min(8, Math.max(1, draft.split("\n").length))}
                placeholder={anyModel ? "Message…  (Enter to send, Shift+Enter for a new line)" : "Pick a model first"}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onPaste={(e) => {
                  const files = Array.from(e.clipboardData.files);
                  if (files.length) {
                    e.preventDefault();
                    void addFiles(files);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    submit();
                  }
                }}
                className="max-h-48 min-h-8 flex-1 resize-none rounded-md border border-line bg-bg px-3 py-1.5 text-[13px] leading-relaxed placeholder:text-faint hover:border-line-strong focus:border-accent focus:outline-none"
              />
              {pg.busy ? (
                <Button variant="danger" icon={<Square className="size-3.5" />} onClick={pg.stop}>
                  Stop
                </Button>
              ) : (
                <Button variant="primary" icon={<Send className="size-3.5" />} disabled={(!draft.trim() && !pending.length) || !anyModel} onClick={submit}>
                  Send
                </Button>
              )}
            </div>
          </div>
        </div>
        {showSettings ? (
          <aside aria-label="Chat settings" className="hidden w-80 shrink-0 border-l border-line bg-panel lg:block">
            <SettingsPanel config={pg.config} onChange={pg.setConfig} primaryModel={pg.panes[0]?.model ?? ""} />
          </aside>
        ) : null}
      </div>
    </>
  );
}
