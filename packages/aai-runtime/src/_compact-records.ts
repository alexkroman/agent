// Copyright 2026 the AAI authors. MIT license.
/**
 * The MODEL's copy of a tool result, with every collection of same-shaped
 * records rendered as ROWS — one record per line — instead of nested JSON.
 *
 * A model reading a long id-keyed map of records, each `{ id, options: {…},
 * flag: bool, amount: number }`, has to hold a field of one record against the
 * fields of its neighbours across hundreds of characters of braces, and it gets
 * that wrong: measured runs computed a minimum over records whose boolean said
 * they were ineligible, and swapped a flag between two adjacent records. The
 * same data as a table puts every field of a record on one line, under a
 * header naming each column once.
 *
 * ## What qualifies
 *
 * A COLLECTION is an array of at least {@link MIN_RECORDS} objects, or an
 * object whose values are all objects and number at least that many (an
 * id-keyed map). It is rendered only when every member is a RECORD — its
 * leaves, after nested plain objects are flattened to dotted keys
 * (`options.size`), are all scalars (string, number, boolean, null) — and every
 * record has the SAME key set. One array or non-empty-object leaf anywhere, one
 * key missing from one record, and the collection stays JSON. Collections are
 * found anywhere in the result, outermost first.
 *
 * ## The format
 *
 * A table is a header line and one line per record, in the original order:
 *
 * ```text
 * 3 records (key column: id): id | options.size | available | price
 * 0012 | S | true | 10
 * 0013 | M | false | 12.5
 * 0014 | L | true | 9
 * ```
 *
 * - **The key column** names what identifies a row. For a map it is the first
 *   field whose value equals the map key in every record (the common case: the
 *   map is keyed by a field the records carry), else a leading `key` column
 *   holding the map key. For an array it is a leading `index` column (0-based).
 * - **Values are verbatim**: strings unquoted and unchanged (a leading zero
 *   survives), numbers as JSON writes them, `true`/`false`, `null`. Inside a
 *   value `\` becomes `\\`, the delimiter `|` becomes `\|`, and a line break
 *   becomes `\n` / `\r`, so a row is always exactly one line.
 * - **Nothing is sorted, filtered or truncated.**
 *
 * A result that IS a collection becomes the bare table. A collection nested in
 * a larger result is spliced in place of its JSON value, on its own lines, with
 * the rest serialized as compact JSON around it — `{"name":"x","items":\n<table>\n}`.
 * That text is deliberately not JSON: what reads it is a model, and a table
 * embedded as a JSON string would put the escaped `\n` back between the rows.
 *
 * ## What is left alone
 *
 * The input is returned BYTE-IDENTICAL when nothing qualifies, when it is not a
 * JSON object or array, when it is a tool failure (a failure's shape is read by
 * the speech and step-guard code downstream), or when it is over
 * `MAX_TOOL_RESULT_CHARS` (the size a result is already warned about).
 *
 * ## Why it parses the text itself
 *
 * `JSON.parse` loses two things this must keep. It REORDERS an object's keys —
 * integer-like keys first, ascending — so an id-keyed map whose ids are digit
 * strings came back in a different order from the one the tool wrote. And it
 * turns a number into a double, so a long integer id loses digits and `1.10`
 * becomes `1.1`. {@link parse} keeps each object's entries in source order and
 * each number and string as its source token; `JSON.parse` still decides
 * whether the text is JSON at all, so this parser only ever reads valid input.
 *
 * Only the model's copy is shaped. The recorded `role: "tool"` message and the
 * client's `tool.completed` frame keep the tool's own string.
 *
 * @module
 */

import { MAX_TOOL_RESULT_CHARS } from "@alexkroman1/aai/internal";
import { isToolFailure, safeJsonParse } from "@alexkroman1/aai/utils";

/** The fewest records a collection needs before it is worth a header line. */
const MIN_RECORDS = 3;

const DELIMITER = " | ";

/**
 * A scalar as it was written: `raw` is its source token (a string keeps its
 * quotes and escapes), `text` the value a table cell shows.
 */
type Scalar = { kind: "scalar"; raw: string; text: string; isString: boolean };
type Node =
  | Scalar
  | { kind: "array"; items: Node[] }
  | { kind: "object"; entries: [string, Node][] };
type ObjectNode = Extract<Node, { kind: "object" }>;

const NUMBER = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const STRING = /"(?:[^"\\]|\\.)*"/y;
const WHITESPACE = /[ \t\n\r]*/y;

/**
 * An order- and token-preserving parser for text `JSON.parse` has already
 * accepted — see the module doc for why `JSON.parse`'s own result will not do.
 */
function parse(source: string): Node {
  let at = 0;
  const skip = (): void => {
    WHITESPACE.lastIndex = at;
    WHITESPACE.exec(source);
    at = WHITESPACE.lastIndex;
  };
  const token = (pattern: RegExp): string => {
    pattern.lastIndex = at;
    const match = pattern.exec(source);
    if (match === null) throw new SyntaxError(`Unexpected token at ${at}`);
    at = pattern.lastIndex;
    return match[0];
  };
  const value = (): Node => {
    skip();
    const c = source[at];
    if (c === "{" || c === "[") return container(c);
    if (c === '"') {
      const raw = token(STRING);
      return { kind: "scalar", raw, text: JSON.parse(raw) as string, isString: true };
    }
    for (const word of ["true", "false", "null"]) {
      if (source.startsWith(word, at)) {
        at += word.length;
        return { kind: "scalar", raw: word, text: word, isString: false };
      }
    }
    const raw = token(NUMBER);
    return { kind: "scalar", raw, text: raw, isString: false };
  };
  const container = (open: "{" | "["): Node => {
    at++;
    const close = open === "{" ? "}" : "]";
    const entries: [string, Node][] = [];
    skip();
    while (source[at] !== close) {
      let key = "";
      if (open === "{") {
        skip();
        key = JSON.parse(token(STRING)) as string;
        skip();
        at++; // ":"
      }
      entries.push([key, value()]);
      skip();
      if (source[at] === ",") at++;
      skip();
    }
    at++;
    return open === "{"
      ? { kind: "object", entries }
      : { kind: "array", items: entries.map(([, v]) => v) };
  };
  return value();
}

/**
 * Flatten one record to dotted-key scalars, or answer `undefined` when it has a
 * leaf a row cannot hold (an array, an empty object) or when a key repeats —
 * a duplicate key, or two paths meeting (`"a.b"` beside `a: { b }`).
 */
function flattenRecord(record: ObjectNode): Map<string, Scalar> | undefined {
  const out = new Map<string, Scalar>();
  const walk = (node: ObjectNode, prefix: string): boolean => {
    if (node.entries.length === 0) return false;
    for (const [key, child] of node.entries) {
      const path = prefix + key;
      if (child.kind === "scalar") {
        if (out.has(path)) return false;
        out.set(path, child);
      } else if (child.kind !== "object" || !walk(child, `${path}.`)) {
        return false;
      }
    }
    return true;
  };
  return walk(record, "") ? out : undefined;
}

function escapeCell(text: string): string {
  return text
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r");
}

/** A column name the records do not already use. */
function freshColumn(name: string, columns: readonly string[]): string {
  let chosen = name;
  while (columns.includes(chosen)) chosen = `_${chosen}`;
  return chosen;
}

/** The records of a collection, keyed by map key or array index. */
function membersOf(node: Node): [string, Node][] | undefined {
  if (node.kind === "array") return node.items.map((item, i) => [String(i), item]);
  if (node.kind === "object") return node.entries;
  return undefined;
}

/**
 * The table for a collection, or `undefined` when `node` is not one: fewer
 * than {@link MIN_RECORDS} members, a member that is not a record, or two
 * members with different key sets.
 */
function tableOf(node: Node): string | undefined {
  const members = membersOf(node);
  if (members === undefined || members.length < MIN_RECORDS) return undefined;
  const rows: Map<string, Scalar>[] = [];
  for (const [, member] of members) {
    const flat = member.kind === "object" ? flattenRecord(member) : undefined;
    if (flat === undefined) return undefined;
    rows.push(flat);
  }
  const columns = [...(rows[0] as Map<string, Scalar>).keys()];
  for (const row of rows) {
    if (row.size !== columns.length || !columns.every((c) => row.has(c))) return undefined;
  }

  const ids = members.map(([id]) => id);
  const isArray = node.kind === "array";
  // A map keyed by a field its records carry names that field, and adds nothing.
  const keyField = isArray
    ? undefined
    : columns.find((c) => rows.every((row, i) => row.get(c)?.text === ids[i]));
  const keyName = keyField ?? freshColumn(isArray ? "index" : "key", columns);
  const header = keyField === undefined ? [keyName, ...columns] : columns;
  const lines = rows.map((row, i) => {
    const cells = columns.map((c) => escapeCell((row.get(c) as Scalar).text));
    if (keyField === undefined) cells.unshift(escapeCell(ids[i] as string));
    return cells.join(DELIMITER);
  });
  const title = `${rows.length} records (key column: ${escapeCell(keyName)}): `;
  return [title + header.map(escapeCell).join(DELIMITER), ...lines].join("\n");
}

/**
 * Serialize `node` as compact JSON from its source tokens, with every
 * collection spliced in as a table; `found.any` reports whether one was.
 */
function render(node: Node, found: { any: boolean }): string {
  const table = tableOf(node);
  if (table !== undefined) {
    found.any = true;
    return `\n${table}\n`;
  }
  if (node.kind === "scalar") return node.raw;
  if (node.kind === "array") return `[${node.items.map((v) => render(v, found)).join(",")}]`;
  const parts = node.entries.map(([k, v]) => `${JSON.stringify(k)}:${render(v, found)}`);
  return `{${parts.join(",")}}`;
}

/**
 * The model's copy of a tool result: `text` with its same-shaped record
 * collections rendered as rows, or `text` itself, byte-identical, when there is
 * nothing to render. See the module doc for the rule and the format.
 */
export function compactRecordsForModel(text: string): string {
  if (text.length > MAX_TOOL_RESULT_CHARS) return text;
  const first = text.trimStart()[0];
  if (first !== "{" && first !== "[") return text;
  // `JSON.parse` is the validity check, and the failure shape is its result's.
  const parsed: unknown = safeJsonParse(text);
  if (parsed === undefined || isToolFailure(parsed)) return text;
  const root = parse(text);
  // The whole result as one collection is the bare table, not `\n<table>\n`.
  const whole = tableOf(root);
  if (whole !== undefined) return whole;
  const found = { any: false };
  const out = render(root, found);
  return found.any ? out : text;
}
