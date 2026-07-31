// Copyright 2025 the AAI authors. MIT license.

/** @jsxImportSource react */

import { memo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useTheme } from "../context.ts";
import { SURFACE_TINT, TEXT_MUTED } from "./_colors.ts";

const BARE_ORDERED_MARKER = /^(\s*)(\d{1,9})([.)])\s*$/;
const BARE_BULLET_MARKER = /^(\s*)([-*+])\s*$/;
const CODE_FENCE = /^\s*(```|~~~)/;

/**
 * Escape list markers that have no content, so a terse reply renders as
 * text instead of vanishing. CommonMark parses a line that is only `42.`
 * as an *empty* ordered list starting at 42 — a voice agent answering
 * "what's 6 times 7?" with "42." would otherwise display nothing (and a
 * streaming transcript briefly ending on `1.` would blank the row).
 * Lines inside fenced code blocks are left alone.
 */
function escapeBareListMarkers(text: string): string {
  let inFence = false;
  return text
    .split("\n")
    .map((line) => {
      if (CODE_FENCE.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      const ordered = BARE_ORDERED_MARKER.exec(line);
      if (ordered) return `${ordered[1]}${ordered[2]}\\${ordered[3]}`;
      const bullet = BARE_BULLET_MARKER.exec(line);
      if (bullet) return `${bullet[1]}\\${bullet[2]}`;
      return line;
    })
    .join("\n");
}

/**
 * Agent prose, rendered as Markdown.
 *
 * Pipeline and S2S models write emphasis, lists, `code`, and links; before
 * this they arrived as literal asterisks and backticks. Styling is
 * per-element (theme colors via inline styles, spacing via Tailwind) so it
 * stays on the default client's type scale and follows custom themes.
 * GFM is on for tables and strikethrough. react-markdown does not render
 * raw HTML unless rehype-raw is added — keep it that way, this text comes
 * from a model.
 *
 * Memoized alongside `MessageBubble`: message content is referentially
 * stable across snapshots, so only the streaming row re-parses.
 *
 * @public
 */
export const Markdown = memo(function Markdown({ text }: { text: string }): ReactNode {
  const theme = useTheme();
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: (props) => <p className="my-1.5 first:mt-0 last:mb-0" {...props} />,
        ul: (props) => <ul className="my-1.5 list-disc pl-5" {...props} />,
        ol: (props) => <ol className="my-1.5 list-decimal pl-5" {...props} />,
        li: (props) => <li className="my-0.5" {...props} />,
        h1: (props) => <h1 className="mt-3 mb-1.5 text-[17px] font-semibold" {...props} />,
        h2: (props) => <h2 className="mt-3 mb-1.5 text-[16px] font-semibold" {...props} />,
        h3: (props) => <h3 className="mt-3 mb-1.5 text-[15px] font-semibold" {...props} />,
        a: ({ style, ...props }) => (
          <a
            className="underline underline-offset-2"
            style={{ color: theme.primary, ...style }}
            target="_blank"
            rel="noreferrer noopener"
            {...props}
          />
        ),
        code: ({ className, style, children, ...rest }) => {
          // react-markdown marks fenced blocks with a language- class and
          // wraps them in <pre>; anything else is an inline span.
          const fenced = /language-/.test(className ?? "");
          return fenced ? (
            <code className="font-aai-mono text-[12.5px]" {...rest}>
              {children}
            </code>
          ) : (
            <code
              className="rounded-sm border px-1 py-0.5 font-aai-mono text-[12.5px]"
              style={{ borderColor: theme.border, background: SURFACE_TINT, ...style }}
              {...rest}
            >
              {children}
            </code>
          );
        },
        pre: ({ style, ...props }) => (
          <pre
            className="my-1.5 overflow-x-auto rounded-md border p-2.5 whitespace-pre-wrap wrap-break-word"
            style={{ borderColor: theme.border, background: SURFACE_TINT, ...style }}
            {...props}
          />
        ),
        blockquote: ({ style, ...props }) => (
          <blockquote
            className="my-1.5 border-l-2 pl-3"
            style={{ borderColor: theme.border, color: TEXT_MUTED, ...style }}
            {...props}
          />
        ),
        table: (props) => <table className="my-1.5 w-full border-collapse text-sm" {...props} />,
        th: ({ style, ...props }) => (
          <th
            className="border px-2 py-1 text-left font-medium"
            style={{ borderColor: theme.border, ...style }}
            {...props}
          />
        ),
        td: ({ style, ...props }) => (
          <td
            className="border px-2 py-1"
            style={{ borderColor: theme.border, ...style }}
            {...props}
          />
        ),
        hr: ({ style, ...props }) => (
          <hr
            className="my-2.5 border-t"
            style={{ borderColor: theme.border, ...style }}
            {...props}
          />
        ),
      }}
    >
      {escapeBareListMarkers(text)}
    </ReactMarkdown>
  );
});
