// Copyright 2026 the AAI authors. MIT license.
/**
 * `fitToolResult` — shrink a big API answer to fit a tool result, keeping its
 * SHAPE, and say that it was shrunk.
 *
 * The runtime caps every tool result at `MAX_TOOL_RESULT_CHARS` by cutting the
 * serialized string and appending a marker. That is the right backstop and the
 * wrong tool: a cut through the middle of a JSON document hands the model half
 * an object, and the model re-reads that result on every later step of the
 * turn. An API answer is usually big for boring reasons — `null` fields, empty
 * lists, an email's HTML body, fifty rows where five were wanted — and each of
 * those has a better cut than "stop at character N":
 *
 * 1. drop what says nothing: `null`, `undefined`, `""`, `[]`, `{}`;
 * 2. clip long strings (`maxString`), marked with `…`;
 * 3. while it is still too long, drop items from the END of the longest list,
 *    a quarter at a time, and record how many each list kept;
 * 4. if it still does not fit (one huge string, no list to shorten), hand
 *    over the start of the JSON text.
 *
 * A trimmed answer is wrapped as `{ result, note }`, and the note says how
 * many items were kept and dropped, so the model knows the rest EXISTS and can
 * ask for less instead of reporting a partial list as the whole one.
 *
 * @module fit-tool-result
 */

import { MAX_TOOL_RESULT_CHARS } from "./constants.ts";
import { isRecord } from "./is-record.ts";

/** Marks a clipped string, as the runtime's own truncation does. */
const CLIP_MARKER = "…";

/** Bound on trimming passes; each drops at least one item, most drop a quarter of a list. */
const MAX_TRIM_PASSES = 256;

/**
 * What {@link fitToolResult} takes.
 *
 * @public
 */
export interface FitToolResultOptions {
  /** Longest the serialized answer may be, in characters. Default `MAX_TOOL_RESULT_CHARS`. */
  maxChars?: number;
  /** Longest any one string may be; longer ones are clipped with `…`. Default: no clip. */
  maxString?: number;
  /**
   * Appended to the note on a trimmed answer — where the rest can be had:
   * `"Use the workbench to go through all of them."`.
   */
  hint?: string;
}

function clip(text: string, max: number | undefined): string {
  if (max === undefined || text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - CLIP_MARKER.length))}${CLIP_MARKER}`;
}

/** True for a value that carries nothing: dropped from objects and lists. */
function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === "object" && Object.keys(value).length === 0;
}

/** `value` without nulls and empties, its strings clipped. A fresh copy; the input is not touched. */
function compact(value: unknown, maxString: number | undefined): unknown {
  if (typeof value === "string") return clip(value, maxString);
  if (Array.isArray(value)) {
    return value.map((v) => compact(v, maxString)).filter((v) => !isEmpty(v));
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const c = compact(v, maxString);
      if (!isEmpty(c)) out[k] = c;
    }
    return out;
  }
  // A non-JSON value (a function, a bigint) would throw or vanish in the
  // serialization; `JSON.stringify` decides what it becomes, as it would anyway.
  return value;
}

/** The list in `value` whose JSON is longest, among lists with more than one item. */
function longestList(value: unknown): unknown[] | undefined {
  let best: { list: unknown[]; chars: number } | undefined;
  const consider = (list: unknown[]): void => {
    if (list.length < 2) return;
    const chars = JSON.stringify(list).length;
    if (best === undefined || chars > best.chars) best = { list, chars };
  };
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) {
      consider(v);
      for (const item of v) visit(item);
    } else if (isRecord(v)) {
      for (const item of Object.values(v)) visit(item);
    }
  };
  visit(value);
  return best?.list;
}

function trimNote(dropped: Map<unknown[], number>, hint: string | undefined): string {
  const lists = [...dropped].map(([list, n]) => `kept ${list.length} of ${list.length + n}`);
  const tail = hint === undefined ? "" : ` ${hint}`;
  return `Trimmed to fit: ${lists.join("; ")}. Ask for fewer or narrower results.${tail}`;
}

/**
 * `value` made to fit a tool result of `maxChars` characters of JSON without
 * cutting through its structure — nulls and empties dropped, long strings
 * clipped, the longest lists shortened from the end — plus a `note` saying so
 * when anything was trimmed from a list. See the module doc for the order.
 *
 * Answers `value` compacted when that alone fits; `{ result, note }` when
 * lists were shortened; `{ result_start, note }` (the start of the JSON text)
 * when nothing structural could make it fit. Never mutates `value`.
 *
 * @example
 * ```ts
 * import { fitToolResult } from "@alexkroman1/aai/utils";
 *
 * export function emailsForModel(emails: unknown[]): unknown {
 *   return fitToolResult({ emails }, { maxChars: 12_000, maxString: 800 });
 * }
 * ```
 *
 * @public
 */
export function fitToolResult(value: unknown, options: FitToolResultOptions = {}): unknown {
  const max = options.maxChars ?? MAX_TOOL_RESULT_CHARS;
  const copy = compact(value, options.maxString);
  const size = (v: unknown): number => JSON.stringify(v ?? null).length;
  if (size(copy) <= max) return copy;

  const dropped = new Map<unknown[], number>();
  const wrapped = (): unknown =>
    dropped.size === 0 ? copy : { result: copy, note: trimNote(dropped, options.hint) };
  for (let pass = 0; pass < MAX_TRIM_PASSES && size(wrapped()) > max; pass++) {
    const list = longestList(copy);
    if (list === undefined) break;
    const cut = Math.max(1, Math.floor(list.length / 4));
    list.splice(list.length - cut, cut);
    dropped.set(list, (dropped.get(list) ?? 0) + cut);
  }
  if (size(wrapped()) <= max) return wrapped();

  const note = `Trimmed to fit: too long to hand over whole, so this is only the start.${
    options.hint === undefined ? "" : ` ${options.hint}`
  }`;
  const text = JSON.stringify(copy ?? null);
  // JSON-escaping the slice grows it, so shrink until the whole answer fits.
  let room = Math.max(0, max - note.length - 40);
  let answer = { result_start: text.slice(0, room), note };
  while (room > 0 && size(answer) > max) {
    room = Math.floor(room * 0.9);
    answer = { result_start: text.slice(0, room), note };
  }
  return answer;
}
