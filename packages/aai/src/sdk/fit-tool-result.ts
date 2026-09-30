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

/**
 * One list or object of the compacted copy, with the length of its JSON text.
 * Built once; a trim updates `chars` on the trimmed list and its ancestors, so
 * no pass re-serializes anything.
 */
interface Branch {
  chars: number;
  parent: Branch | undefined;
  /** Inside an item a trim removed: no longer a candidate. */
  dead: boolean;
  /** The branches directly below this one, so a removed item can mark its own dead. */
  kids: Branch[];
  /** Set on a list only: the list itself. */
  list?: unknown[];
  /** Set on a list only: each item's JSON length. */
  itemChars?: number[];
  /** Set on a list only: each item's branch, when the item is a list or object. */
  itemBranches?: (Branch | undefined)[];
}

/** Every list of the tree, in the pre-order `longestList` walks, and the tree's JSON length. */
interface Measured {
  lists: Branch[];
  rootChars: number;
}

/** Length of `{"result":` + `,"note":` + `}` around the result's and the note's JSON. */
const WRAP_CHARS = '{"result":,"note":}'.length;

/** True for a value `JSON.stringify` would hand to its `toJSON`. */
function hasToJson(v: unknown): boolean {
  return v !== null && v !== undefined && typeof (v as { toJSON?: unknown }).toJSON === "function";
}

/**
 * Measure `root`'s JSON text node by node, the way `JSON.stringify` writes it:
 * a list item that serializes to nothing is `null`, an object key whose value
 * serializes to nothing is omitted. Answers `undefined` for a tree holding a
 * `toJSON` method — its text can depend on the key it is written under, which
 * a trim moves — so the caller measures that one the slow way.
 */
function measure(root: unknown): Measured | undefined {
  const lists: Branch[] = [];
  let exotic = false;
  const walkList = (v: unknown[], parent: Branch | undefined): number => {
    const itemChars: number[] = [];
    const itemBranches: (Branch | undefined)[] = [];
    const branch: Branch = { chars: 0, parent, dead: false, kids: [], list: v };
    branch.itemChars = itemChars;
    branch.itemBranches = itemBranches;
    parent?.kids.push(branch);
    lists.push(branch);
    let chars = 2 + Math.max(0, v.length - 1);
    for (const item of v) {
      const kidsBefore = branch.kids.length;
      const c = walk(item, branch) ?? "null".length;
      itemChars.push(c);
      itemBranches.push(branch.kids.length > kidsBefore ? branch.kids.at(-1) : undefined);
      chars += c;
    }
    branch.chars = chars;
    return chars;
  };
  const walkRecord = (v: Record<string, unknown>, parent: Branch | undefined): number => {
    const branch: Branch = { chars: 0, parent, dead: false, kids: [] };
    parent?.kids.push(branch);
    let chars = 2;
    let written = 0;
    for (const key of Object.keys(v)) {
      const c = walk(v[key], branch);
      if (c === undefined) continue;
      chars += JSON.stringify(key).length + 1 + c;
      written++;
    }
    chars += Math.max(0, written - 1);
    branch.chars = chars;
    return chars;
  };
  function walk(v: unknown, parent: Branch | undefined): number | undefined {
    if (exotic) return 0;
    if (hasToJson(v)) {
      exotic = true;
      return 0;
    }
    if (Array.isArray(v)) return walkList(v, parent);
    if (isRecord(v)) return walkRecord(v, parent);
    return JSON.stringify(v)?.length;
  }
  const rootChars = walk(root, undefined);
  return exotic ? undefined : { lists, rootChars: rootChars ?? 0 };
}

function markDead(branch: Branch): void {
  branch.dead = true;
  for (const kid of branch.kids) markDead(kid);
}

/**
 * The live list whose JSON is longest, among lists with more than one item;
 * the first in walk order wins a tie, as `longestList`'s pre-order scan does.
 */
function longestBranch(lists: Branch[]): Branch | undefined {
  let best: Branch | undefined;
  for (const branch of lists) {
    if (branch.dead || (branch.list?.length ?? 0) < 2) continue;
    if (best === undefined || branch.chars > best.chars) best = branch;
  }
  return best;
}

/**
 * Shorten lists in `copy` (in place) until `copy`, wrapped with its note, fits
 * `max` or no list can be shortened, recording each cut in `dropped`: the
 * longest list loses a quarter from its end, per pass. Every node is measured
 * once; a cut subtracts the removed items' lengths from the list and its
 * ancestors, so a pass costs a scan of the lists, not a serialization.
 */
function trimLists(
  copy: unknown,
  max: number,
  dropped: Map<unknown[], number>,
  hint: string | undefined,
): void {
  const measured = measure(copy);
  if (measured === undefined) {
    trimListsByReserializing(copy, max, dropped, hint);
    return;
  }
  const { lists } = measured;
  let chars = measured.rootChars;
  const wrappedChars = (): number =>
    dropped.size === 0
      ? chars
      : WRAP_CHARS + chars + JSON.stringify(trimNote(dropped, hint)).length;
  for (let pass = 0; pass < MAX_TRIM_PASSES && wrappedChars() > max; pass++) {
    const branch = longestBranch(lists);
    const list = branch?.list;
    if (branch === undefined || list === undefined) break;
    const cut = Math.max(1, Math.floor(list.length / 4));
    chars -= cutFromEnd(branch, list, cut);
    dropped.set(list, (dropped.get(list) ?? 0) + cut);
  }
}

/**
 * Remove the last `cut` items of `list` (the list `branch` measures), take
 * their length off `branch` and every ancestor, and answer that length.
 */
function cutFromEnd(branch: Branch, list: unknown[], cut: number): number {
  list.splice(list.length - cut, cut);
  // n items carry n - 1 commas and at least one item stays, so `cut` commas go too.
  let removed = cut;
  for (const c of branch.itemChars?.splice(-cut, cut) ?? []) removed += c;
  for (const b of branch.itemBranches?.splice(-cut, cut) ?? []) if (b) markDead(b);
  for (let b: Branch | undefined = branch; b; b = b.parent) b.chars -= removed;
  return removed;
}

/**
 * {@link trimLists} for a tree holding a `toJSON` method, which only
 * `JSON.stringify` can measure: every pass re-serializes each list and the
 * whole answer. A compacted API answer never holds one.
 */
function trimListsByReserializing(
  copy: unknown,
  max: number,
  dropped: Map<unknown[], number>,
  hint: string | undefined,
): void {
  const size = (): number =>
    JSON.stringify(dropped.size === 0 ? copy : { result: copy, note: trimNote(dropped, hint) })
      .length;
  for (let pass = 0; pass < MAX_TRIM_PASSES && size() > max; pass++) {
    const list = longestList(copy);
    if (list === undefined) break;
    const cut = Math.max(1, Math.floor(list.length / 4));
    list.splice(list.length - cut, cut);
    dropped.set(list, (dropped.get(list) ?? 0) + cut);
  }
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
  trimLists(copy, max, dropped, options.hint);
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
