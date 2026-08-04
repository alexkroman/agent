// Copyright 2026 the AAI authors. MIT license.
// Tool-call rendering for the chat transcript: aai-ui's shared ToolCallRow
// (the same console row the deployed agent UI uses) fed from AI SDK message
// parts, plus the part→block grouping helpers. Split from chat.tsx for
// file-size discipline.

import { ToolCallRow } from "@alexkroman1/aai-ui";
import type { UIMessage } from "ai";

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
 * One tool invocation from an AI SDK message, rendered through aai-ui's
 * `ToolCallRow` (compact variant) so the studio transcript and the deployed
 * agent UI read as one component. This wrapper owns only the data mapping:
 * part→name/args, the shimmer condition, and the capped expansion content.
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
  const rawName = toolPartName(part as { type: string; toolName?: string });
  const name = labels?.[rawName] ?? prettyToolName(rawName);
  const done = part.state === "output-available";
  const output = part.output;
  const args = part.input == null ? "" : JSON.stringify(part.input);
  const canExpand = part.input != null || (done && output != null);

  return (
    <ToolCallRow
      title={name}
      detail={args}
      pending={!done && active}
      variant="compact"
      className="my-1"
    >
      {canExpand ? (
        <div className="px-3 py-2 text-subtle">
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
      ) : undefined}
    </ToolCallRow>
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
