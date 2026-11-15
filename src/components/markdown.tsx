"use client";

import { Fragment, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";

/**
 * A small, dependency-free Markdown renderer for model output. It builds React elements
 * directly (never innerHTML), so model text cannot inject markup. Supported: fenced code,
 * headings, lists, blockquotes, bold, italics, inline code and http(s) links.
 */

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="group relative my-2 overflow-hidden rounded-md border border-line bg-subtle">
      <div className="flex items-center justify-between border-b border-line px-3 py-1 text-[11px] text-faint">
        <span className="font-mono">{lang || "text"}</span>
        <button
          type="button"
          onClick={async () => {
            await navigator.clipboard.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
          className="inline-flex items-center gap-1 rounded px-1 hover:bg-hover hover:text-fg"
        >
          {copied ? <Check className="size-3 text-ok" /> : <Copy className="size-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-xs leading-relaxed">
        <code>{code}</code>
      </pre>
    </div>
  );
}

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\s][^*\n]*\*)|(\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g;

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const start = match.index ?? 0;
    if (start > last) out.push(text.slice(last, start));
    const token = match[0];
    const key = `${start}-${token.length}`;
    if (token.startsWith("`")) {
      out.push(
        <code key={key} className="rounded bg-subtle px-1 py-px font-mono text-[0.92em]">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("**")) {
      out.push(<strong key={key}>{inline(token.slice(2, -2))}</strong>);
    } else if (token.startsWith("*")) {
      out.push(<em key={key}>{inline(token.slice(1, -1))}</em>);
    } else {
      const split = token.indexOf("](");
      out.push(
        <a key={key} href={token.slice(split + 2, -1)} target="_blank" rel="noreferrer noopener" className="text-accent-text underline">
          {token.slice(1, split)}
        </a>,
      );
    }
    last = start + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type Block =
  | { kind: "code"; lang: string; code: string }
  | { kind: "heading"; level: number; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "para"; text: string };

function parse(src: string): Block[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\s*```(\S*)/);
    if (fence) {
      const body: string[] = [];
      i++;
      // An unterminated fence (still streaming) simply runs to the end.
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++;
      blocks.push({ kind: "code", lang: fence[1], code: body.join("\n") });
      continue;
    }
    if (line.trim() === "") {
      i++;
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2] });
      i++;
      continue;
    }
    const bullet = /^\s*[-*+]\s+/;
    const numbered = /^\s*\d+[.)]\s+/;
    if (bullet.test(line) || numbered.test(line)) {
      const ordered = numbered.test(line);
      const marker = ordered ? numbered : bullet;
      const items: string[] = [];
      while (i < lines.length && marker.test(lines[i])) items.push(lines[i++].replace(marker, ""));
      blocks.push({ kind: "list", ordered, items });
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ""));
      blocks.push({ kind: "quote", text: quote.join("\n") });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !/^\s*```/.test(lines[i]) && !/^#{1,6}\s/.test(lines[i]) && !bullet.test(lines[i]) && !numbered.test(lines[i])) {
      para.push(lines[i++]);
    }
    blocks.push({ kind: "para", text: para.join("\n") });
  }
  return blocks;
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="space-y-2 text-[13px] leading-relaxed break-words">
      {parse(text).map((b, i) => {
        switch (b.kind) {
          case "code":
            return <CodeBlock key={i} code={b.code} lang={b.lang} />;
          case "heading":
            return (
              <p key={i} className={b.level <= 2 ? "pt-1 text-sm font-semibold" : "pt-1 font-semibold"}>
                {inline(b.text)}
              </p>
            );
          case "list": {
            const Tag = b.ordered ? "ol" : "ul";
            return (
              <Tag key={i} className={b.ordered ? "list-decimal space-y-0.5 pl-5" : "list-disc space-y-0.5 pl-5"}>
                {b.items.map((item, j) => (
                  <li key={j}>{inline(item)}</li>
                ))}
              </Tag>
            );
          }
          case "quote":
            return (
              <blockquote key={i} className="border-l-2 border-line-strong pl-3 text-muted">
                {inline(b.text)}
              </blockquote>
            );
          case "para":
            return (
              <p key={i} className="whitespace-pre-wrap">
                {b.text.split("\n").map((l, j) => (
                  <Fragment key={j}>
                    {j > 0 ? "\n" : null}
                    {inline(l)}
                  </Fragment>
                ))}
              </p>
            );
        }
      })}
    </div>
  );
}
