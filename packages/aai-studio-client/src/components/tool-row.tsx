// Copyright 2026 the AAI authors. MIT license.
// Tool-call rendering for the chat transcript: aai-ui's shared ToolCallRow
// (the same console row the deployed agent UI uses) fed from AI SDK message
// parts, plus the part→block grouping helpers. Split from panes/chat.tsx for
// file-size discipline.

import { isRecord } from "@alexkroman1/aai/utils";
import { ToolCallRow } from "@alexkroman1/aai-ui";
import {
  type DynamicToolUIPart,
  getToolName,
  isTextUIPart,
  isToolUIPart,
  type ToolUIPart,
  type UIMessage,
} from "ai";
import { CheckIcon } from "./icons.tsx";

/** One tool call in a message — a static tool's part or a dynamic one's. */
export type ToolPart = ToolUIPart | DynamicToolUIPart;

/** Caps on the expanded row's raw JSON — a peek, not a document viewer. */
const ARGS_PREVIEW_CHARS = 300;
const OUTPUT_PREVIEW_CHARS = 600;
/** Cap on the collapsed row's one-line argument summary. */
const ARGS_SUMMARY_CHARS = 64;

/**
 * Argument names that say WHAT a call is about, most identifying first.
 *
 * The collapsed row has space for one short phrase, and for every tool in the
 * guest's set that phrase is one of these — a path, a pattern, a command —
 * never the whole argument record. `write_file` is the clearest case: its
 * `content` is the entire file, so a serialized record is a wall of escaped
 * source where "agent.ts" was the only word worth showing.
 */
const HEADLINE_ARG_KEYS = [
  // Ahead of `path` on purpose: `grep`/`glob` take both, and the pattern is
  // the question while the path is only where it was asked.
  "command",
  "pattern",
  "template",
  "query",
  "url",
  "path",
  "filePath",
  "file",
  "name",
];

/** A scalar rendered as plain text, or null when there is nothing to render. */
function scalarText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() === "" ? null : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

/** One line, whitespace collapsed, ellipsized — never a scrollbar in the header. */
function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * The collapsed row's argument summary: what a person would say the call was
 * about, not its serialized input.
 *
 * Serialized input was the default and it read badly at both ends. A no-arg
 * call showed a literal `{}` — visual noise announcing the absence of
 * information — and an interesting one showed truncated JSON
 * (`{"template":"web-…`) that cut off before the value anyone wanted. Empty
 * renders as nothing; the full record is one click away in the expansion.
 *
 * Exported for tests.
 */
export function summarizeArgs(input: unknown): string {
  const direct = scalarText(input);
  if (direct !== null) return clip(direct, ARGS_SUMMARY_CHARS);
  // `isRecord` already excludes null and arrays, and — the point of using it —
  // narrows, so the `Object.entries` below needs no cast asserting what the
  // check was supposed to establish.
  if (!isRecord(input)) return "";
  const entries = Object.entries(input).flatMap(([key, value]) => {
    const text = scalarText(value);
    return text === null ? [] : [[key, text] as const];
  });
  if (entries.length === 0) return "";
  // One index, then the first headline key this call actually carries — or, for
  // a lone argument, that argument, whatever it is called. The earlier
  // `map(...).find(Boolean)` re-scanned the whole entry list once per headline
  // key even after the hit, and this runs for every tool row of a streaming
  // message.
  const byName = new Map(entries);
  const candidates = entries.length === 1 ? [...byName.keys()] : HEADLINE_ARG_KEYS;
  for (const key of candidates) {
    const value = byName.get(key);
    if (value !== undefined) return clip(value, ARGS_SUMMARY_CHARS);
  }
  return clip(entries.map(([key, text]) => `${key}: ${text}`).join(", "), ARGS_SUMMARY_CHARS);
}

/** Cap `text`, marking the cut so a clipped payload never reads as the whole one. */
function preview(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… ${text.length - max} more characters` : text;
}

/** Fallback when the sandbox hasn't served a label: "write_file" → "Write file". */
export function prettyToolName(name: string): string {
  const words = name.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The name a person reads for a tool part: the sandbox's label, else a prettified raw name. */
export function toolTitle(part: ToolPart, labels?: Record<string, string> | undefined): string {
  // "tool" for a dynamic part that arrived without its name: the transcript
  // is read off the wire, and `isChatMessages` does not check the parts.
  const rawName = getToolName(part) || "tool";
  return labels?.[rawName] ?? prettyToolName(rawName);
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
  part: ToolPart;
  /** False once the turn is over — a call abandoned by Stop must not shimmer forever. */
  active?: boolean;
  /** Tool name → friendly label (from the sandbox's GET /studio/tools). */
  labels?: Record<string, string> | undefined;
}) {
  const name = toolTitle(part, labels);
  const done = part.state === "output-available";
  const output = part.state === "output-available" ? part.output : undefined;
  // An empty record is not an argument — `{}` in the expansion said exactly
  // as little as `{}` in the header did, twice.
  const hasArgs =
    part.input != null && !(typeof part.input === "object" && isEmptyRecord(part.input));
  const outputText = done && output != null ? asText(output) : null;
  const canExpand = hasArgs || outputText != null;

  return (
    <ToolCallRow
      title={name}
      detail={summarizeArgs(part.input)}
      pending={!done && active}
      // The step's state in place of aai-ui's "TOOL" chip: inside a step
      // group every row is a tool, so the chip only repeated the group's
      // own heading.
      icon={
        done ? (
          <span className="flex text-emerald-600">
            <CheckIcon size={13} />
          </span>
        ) : (
          <span className="mt-1.5 ml-1.5 block h-1.5 w-1.5 rounded-full bg-line-strong" />
        )
      }
      variant="compact"
      className="my-1"
    >
      {canExpand ? (
        <div className="flex flex-col gap-1 px-3 py-2 text-subtle">
          {hasArgs && (
            // Indented, so a multi-argument call is a readable list rather
            // than one unbroken line. `break-words` (not `break-all`) keeps
            // paths and identifiers whole — mid-token breaks are what made
            // the old output blocks hard to scan.
            <code className="block overflow-x-auto font-mono text-[10px] break-words whitespace-pre-wrap">
              {preview(JSON.stringify(part.input, null, 2), ARGS_PREVIEW_CHARS)}
            </code>
          )}
          {outputText != null && (
            <pre className="m-0 block overflow-x-auto font-mono text-[10px] break-words whitespace-pre-wrap">
              {outputText.trim() === "" ? "(no output)" : preview(outputText, OUTPUT_PREVIEW_CHARS)}
            </pre>
          )}
        </div>
      ) : undefined}
    </ToolCallRow>
  );
}

function isEmptyRecord(value: object): boolean {
  return !Array.isArray(value) && Object.keys(value).length === 0;
}

/** A tool result as text — string outputs render verbatim, the rest as JSON. */
function asText(output: unknown): string {
  return typeof output === "string" ? output : JSON.stringify(output);
}

type MessageBlock =
  | { key: string; kind: "text"; text: string }
  | { key: string; kind: "tool"; part: ToolPart };

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
    if (isTextUIPart(part)) {
      const last = blocks.at(-1);
      if (last?.kind === "text") {
        last.text += part.text;
      } else {
        blocks.push({ key: `text-${lastToolKey}`, kind: "text", text: part.text });
      }
    } else if (isToolUIPart(part)) {
      // The fallback for a wire part without its id, which nothing checked.
      lastToolKey = part.toolCallId ?? `tool-${blocks.length}`;
      blocks.push({ key: lastToolKey, kind: "tool", part });
    }
  }
  return blocks;
}
