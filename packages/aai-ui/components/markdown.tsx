// Copyright 2025 the AAI authors. MIT license.

/** @jsxImportSource react */

import clsx from "clsx";
import {
  type FunctionComponent,
  type MemoExoticComponent,
  memo,
  type ReactNode,
  useMemo,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { useTheme } from "../context.ts";
import { INK_MUTED_PCT, INK_SURFACE_PCT, inkTint } from "./_colors.ts";

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
 * Type scale for {@link Markdown}: `"default"` is the deployed agent UI's
 * scale, `"compact"` a notch smaller for denser surfaces (the studio's chat
 * transcript). Colors are unaffected — they come from the theme either way.
 *
 * @public
 */
export type MarkdownVariant = "default" | "compact";

// Per-variant type scale. Full class strings (never composed) so Tailwind's
// scanner sees every candidate.
const SCALE_CLASSES: Record<
  MarkdownVariant,
  { h1: string; h2: string; h3: string; code: string; table: string }
> = {
  default: {
    h1: "mt-3 mb-1.5 text-[17px] font-semibold",
    h2: "mt-3 mb-1.5 text-[16px] font-semibold",
    h3: "mt-3 mb-1.5 text-[15px] font-semibold",
    code: "text-[12.5px]",
    table: "my-1.5 w-full border-collapse text-sm",
  },
  compact: {
    h1: "mt-3 mb-1.5 text-[15px] font-medium",
    h2: "mt-3 mb-1.5 text-[14px] font-medium",
    h3: "mt-3 mb-1.5 text-[13px] font-medium",
    code: "text-[11px]",
    table: "my-1.5 w-full border-collapse text-[12px]",
  },
};

/**
 * Props of {@link Markdown}.
 *
 * @public
 */
export type MarkdownProps = {
  /**
   * The Markdown source. Required — this is the prose to render, normally one
   * agent message or the streaming tail of one.
   */
  text: string;
  /**
   * Type scale. Defaults to `"default"`, the deployed agent UI's scale; pass
   * `"compact"` for a denser surface. Colors are unaffected either way.
   */
  variant?: MarkdownVariant;
};

/**
 * Agent prose, rendered as Markdown.
 *
 * Pipeline and S2S models write emphasis, lists, `code`, and links; before
 * this they arrived as literal asterisks and backticks. Styling is
 * per-element (theme colors via inline styles, spacing via Tailwind) so it
 * stays on the default client's type scale and follows custom themes.
 * The optional `variant` selects the type scale (see
 * {@link MarkdownVariant}).
 * GFM is on for tables and strikethrough. react-markdown does not render
 * raw HTML unless rehype-raw is added — keep it that way, this text comes
 * from a model.
 *
 * Memoized alongside `MessageBubble`: message content is referentially
 * stable across snapshots, so only the streaming row re-parses.
 *
 * @example
 * ```tsx
 * import { Markdown, useSessionSelector } from "@alexkroman1/aai-ui";
 *
 * // The agent's reply as it streams, rendered rather than shown as literal
 * // asterisks and backticks.
 * function LiveReply() {
 *   const text = useSessionSelector((snapshot) => snapshot.agentTranscript);
 *   return text === null ? null : <Markdown text={text} variant="compact" />;
 * }
 * ```
 *
 * @public
 */
export const Markdown: MemoExoticComponent<FunctionComponent<MarkdownProps>> = memo(
  function Markdown({ text, variant = "default" }: MarkdownProps): ReactNode {
    const theme = useTheme();
    const scale = SCALE_CLASSES[variant];
    // The renderer map is ~20 closures — rebuild it only when the theme or
    // variant changes (both identity-stable), not on every streamed delta of
    // the live assistant bubble.
    const components = useMemo<Components>(
      () => ({
        p: (props) => <p className="my-1.5 first:mt-0 last:mb-0" {...props} />,
        ul: (props) => <ul className="my-1.5 list-disc pl-5" {...props} />,
        ol: (props) => <ol className="my-1.5 list-decimal pl-5" {...props} />,
        li: (props) => <li className="my-0.5" {...props} />,
        h1: (props) => <h1 className={scale.h1} {...props} />,
        h2: (props) => <h2 className={scale.h2} {...props} />,
        h3: (props) => <h3 className={scale.h3} {...props} />,
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
            <code className={clsx("font-aai-mono", scale.code)} {...rest}>
              {children}
            </code>
          ) : (
            <code
              className={clsx("rounded-sm border px-1 py-0.5 font-aai-mono", scale.code)}
              style={{
                borderColor: theme.border,
                background: inkTint(theme.text, theme.surface, INK_SURFACE_PCT),
                ...style,
              }}
              {...rest}
            >
              {children}
            </code>
          );
        },
        pre: ({ style, ...props }) => (
          <pre
            className="my-1.5 overflow-x-auto rounded-md border p-2.5 whitespace-pre-wrap wrap-break-word"
            style={{
              borderColor: theme.border,
              background: inkTint(theme.text, theme.surface, INK_SURFACE_PCT),
              ...style,
            }}
            {...props}
          />
        ),
        blockquote: ({ style, ...props }) => (
          <blockquote
            className="my-1.5 border-l-2 pl-3"
            style={{
              borderColor: theme.border,
              color: inkTint(theme.text, theme.surface, INK_MUTED_PCT),
              ...style,
            }}
            {...props}
          />
        ),
        table: (props) => <table className={scale.table} {...props} />,
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
      }),
      [theme, scale],
    );
    return (
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {escapeBareListMarkers(text)}
      </ReactMarkdown>
    );
  },
);
