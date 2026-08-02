// Copyright 2026 the AAI authors. MIT license.
// Tool-call rendering for the chat transcript: the same console row the
// deployed agent UI uses (aai-ui's ToolCallBlock), plus the part→block
// grouping helpers. Split from chat.tsx for file-size discipline.

import type { UIMessage } from "ai";
import clsx from "clsx";
import { useState } from "react";

/** Caps on the expanded row's raw JSON — a peek, not a document viewer. */
const ARGS_PREVIEW_CHARS = 300;
const OUTPUT_PREVIEW_CHARS = 600;

function toolPartName(part: { type: string; toolName?: string }): string {
  if (part.type === "dynamic-tool") return part.toolName ?? "tool";
  return part.type.replace(/^tool-/, "");
}

/** Fallback when the sandbox hasn't served a label: "write_file" → "Write file". */
export function prettyToolName(name: string): string {
  const words = name.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function isToolPart(part: { type: string }): boolean {
  return part.type.startsWith("tool-") || part.type === "dynamic-tool";
}

/**
 * One tool invocation, rendered as the same console row the deployed agent UI
 * uses (`aai-ui`'s ToolCallBlock): outlined TOOL chip, tool name in mono, a
 * truncated args preview, and a chevron that rotates to expand the result.
 * The two surfaces show the same thing, so they should read as one component —
 * only the type scale differs, since the studio is a denser surface.
 */
export function ToolRow({
  part,
  active = true,
  labels,
}: {
  part: Record<string, unknown> & { type: string };
  /** False once the turn is over — a call abandoned by Stop must not shimmer forever. */
  active?: boolean;
  /** Tool name → friendly label (from the sandbox's GET /studio/tools). */
  labels?: Record<string, string> | undefined;
}) {
  const [open, setOpen] = useState(false);
  const rawName = toolPartName(part as { type: string; toolName?: string });
  const name = labels?.[rawName] ?? prettyToolName(rawName);
  const done = part.state === "output-available";
  const output = part.output;
  const args = part.input == null ? "" : JSON.stringify(part.input);
  const canExpand = part.input != null || (done && output != null);

  return (
    <div className="my-1 overflow-hidden rounded-md border border-line bg-cream">
      <button
        type="button"
        aria-expanded={canExpand ? open : undefined}
        disabled={!canExpand}
        className={clsx(
          "flex w-full appearance-none items-center gap-2 border-none bg-transparent px-3 py-2 text-left select-none",
          canExpand && "cursor-pointer",
        )}
        onClick={() => canExpand && setOpen((v) => !v)}
      >
        <span className="shrink-0 rounded-sm border border-line px-1.5 py-[3px] text-[9px] leading-none font-medium tracking-[1.2px] text-subtle uppercase">
          Tool
        </span>
        <span
          className={clsx(
            "shrink-0 font-mono text-[11px] font-medium text-fg",
            !done && active && "tool-shimmer",
          )}
        >
          {name}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-subtle">{args}</span>
        {canExpand && (
          <span
            className={clsx(
              "shrink-0 text-[9px] text-subtle transition-transform duration-150",
              open && "rotate-90",
            )}
          >
            ▶
          </span>
        )}
      </button>
      {open && (
        <div className="border-t border-line bg-panel px-3 py-2 text-subtle">
          {part.input != null && (
            <code className="block overflow-x-auto font-mono text-[10px] break-all whitespace-pre-wrap">
              {JSON.stringify(part.input).slice(0, ARGS_PREVIEW_CHARS)}
            </code>
          )}
          {done && output != null && (
            <pre className="m-0 mt-1 block overflow-x-auto font-mono text-[10px] break-all whitespace-pre-wrap">
              {(typeof output === "string" ? output : JSON.stringify(output)).slice(
                0,
                OUTPUT_PREVIEW_CHARS,
              )}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

type MessageBlock =
  | { key: string; kind: "text"; text: string }
  | { key: string; kind: "tool"; part: Record<string, unknown> & { type: string } };

/**
 * Group a message's parts into renderable blocks with stable keys: tool
 * blocks key on their toolCallId, text runs key on the tool block they
 * follow (parts are append-only, so these never collide or reorder).
 * Exported for tests.
 */
export function toBlocks(message: UIMessage): MessageBlock[] {
  const blocks: MessageBlock[] = [];
  let lastToolKey = "lead";
  for (const part of message.parts) {
    if (part.type === "text") {
      const last = blocks.at(-1);
      if (last?.kind === "text") {
        last.text += part.text;
      } else {
        blocks.push({ key: `text-${lastToolKey}`, kind: "text", text: part.text });
      }
    } else if (isToolPart(part)) {
      const raw = part as Record<string, unknown> & { type: string };
      lastToolKey = String(raw.toolCallId ?? `tool-${blocks.length}`);
      blocks.push({ key: lastToolKey, kind: "tool", part: raw });
    }
  }
  return blocks;
}
