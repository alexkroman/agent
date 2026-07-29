// Copyright 2026 the AAI authors. MIT license.
/**
 * Surgical text replacement for studio workspace files, with a unified diff.
 *
 * Why this exists: without it the coding agent's only way to change a file is
 * `write_file` with the *entire* new contents. On a 200-line agent.ts that is
 * a full rewrite for a one-line change — slow, token-expensive, and the most
 * common way a model silently drops code it was supposed to keep.
 *
 * The matching and diff logic is ported from edge-pi (MIT), a Vercel AI SDK
 * coding-agent library: https://github.com/marcusschiesser/edge-pi —
 * `packages/edge-pi/src/tools/edit-diff.ts`. Adapted to operate on plain
 * strings, since a studio workspace is a JSON document rather than a
 * filesystem, so the path/fs plumbing around it does not apply.
 */

import * as Diff from "diff";

/** Thrown when an edit cannot be applied; the message goes back to the agent. */
export class StudioEditError extends Error {}

export type LineEnding = "\r\n" | "\n";

export function detectLineEnding(content: string): LineEnding {
  const crlf = content.indexOf("\r\n");
  const lf = content.indexOf("\n");
  if (lf === -1 || crlf === -1) return "\n";
  return crlf < lf ? "\r\n" : "\n";
}

const toLF = (text: string): string => text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

const restoreEndings = (text: string, ending: LineEnding): string =>
  ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;

/**
 * Normalize away the differences a model reliably gets wrong when quoting
 * source back at us: trailing whitespace, smart quotes, unicode dashes, and
 * exotic spaces. Matching on this form turns "close enough" into a match
 * instead of a failed edit the agent then retries blindly.
 */
export function normalizeForFuzzyMatch(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐‑‒–—―−]/g, "-")
    .replace(/[  -   　]/g, " ");
}

type Match = {
  index: number;
  length: number;
  /** Exact match works on the original text; fuzzy works on the normalized form. */
  haystack: string;
};

/** Locate `needle` in `haystack`, exact first then fuzzy. */
function findText(haystack: string, needle: string): Match | null {
  const exact = haystack.indexOf(needle);
  if (exact !== -1) return { index: exact, length: needle.length, haystack };

  const fuzzyHaystack = normalizeForFuzzyMatch(haystack);
  const fuzzyNeedle = normalizeForFuzzyMatch(needle);
  const fuzzy = fuzzyHaystack.indexOf(fuzzyNeedle);
  if (fuzzy === -1) return null;
  return { index: fuzzy, length: fuzzyNeedle.length, haystack: fuzzyHaystack };
}

/** Count non-overlapping occurrences, in the same space the match was found in. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  return haystack.split(needle).length - 1;
}

/** Running position while walking the diff parts. */
type Cursor = { old: number; new: number; width: number; out: string[] };

const gutter = (n: number, width: number): string => String(n).padStart(width, " ");

/** Emit every line of an added/removed part. */
function emitChange(lines: string[], added: boolean, cur: Cursor): void {
  for (const line of lines) {
    cur.out.push(`${added ? "+" : "-"}${gutter(added ? cur.new : cur.old, cur.width)} ${line}`);
    if (added) cur.new += 1;
    else cur.old += 1;
  }
}

/** Emit an unchanged part, trimmed to `context` lines nearest the change(s). */
function emitContext(
  lines: string[],
  cur: Cursor,
  edges: { after: boolean; before: boolean },
  context: number,
): void {
  if (!(edges.after || edges.before)) {
    cur.old += lines.length;
    cur.new += lines.length;
    return;
  }
  // Touching a change on the left keeps the head; on the right, the tail.
  const keep = edges.after ? lines.slice(0, context) : lines.slice(-context);
  const trimmedBefore = edges.after ? 0 : lines.length - keep.length;
  const trimmedAfter = edges.after ? lines.length - keep.length : 0;

  if (trimmedBefore > 0) {
    cur.out.push(` ${" ".repeat(cur.width)} …`);
    cur.old += trimmedBefore;
    cur.new += trimmedBefore;
  }
  for (const line of keep) {
    cur.out.push(` ${gutter(cur.old, cur.width)} ${line}`);
    cur.old += 1;
    cur.new += 1;
  }
  if (trimmedAfter > 0) {
    cur.out.push(` ${" ".repeat(cur.width)} …`);
    cur.old += trimmedAfter;
    cur.new += trimmedAfter;
  }
}

/**
 * A unified diff with line numbers, trimmed to `context` lines around each
 * change — the agent gets to see what it actually did, and so does anyone
 * reading the tool row.
 */
export function formatDiff(before: string, after: string, context = 3): string {
  const parts = Diff.diffLines(before, after);
  const width = String(Math.max(before.split("\n").length, after.split("\n").length)).length;
  const cur: Cursor = { old: 1, new: 1, width, out: [] };

  parts.forEach((part, i) => {
    const lines = part.value.split("\n");
    if (lines.at(-1) === "") lines.pop();
    if (part.added || part.removed) {
      emitChange(lines, Boolean(part.added), cur);
      return;
    }
    emitContext(
      lines,
      cur,
      {
        after: Boolean(parts[i - 1]?.added || parts[i - 1]?.removed),
        before: Boolean(parts[i + 1]?.added || parts[i + 1]?.removed),
      },
      context,
    );
  });

  return cur.out.join("\n");
}

export type EditResult = { content: string; diff: string };

/**
 * Replace `oldText` with `newText` in `content`, exactly once.
 *
 * @throws {StudioEditError} when the text is absent or ambiguous — both are
 * cases where guessing would corrupt the file, so the agent is told to try
 * again with more context rather than having an edit applied to the wrong
 * occurrence.
 */
export function applyEdit(
  path: string,
  content: string,
  oldText: string,
  newText: string,
): EditResult {
  const bom = content.startsWith("﻿") ? "﻿" : "";
  const body = bom ? content.slice(1) : content;
  const ending = detectLineEnding(body);
  const normalized = toLF(body);
  const from = toLF(oldText);
  const to = toLF(newText);

  if (from.length === 0) {
    throw new StudioEditError(`oldText must not be empty (editing ${path})`);
  }

  const match = findText(normalized, from);
  if (!match) {
    throw new StudioEditError(
      `Could not find that text in ${path}. It must match the file exactly, ` +
        "including whitespace and newlines — read the file and copy the text verbatim.",
    );
  }

  const occurrences = countOccurrences(
    match.haystack,
    match.haystack === normalized ? from : normalizeForFuzzyMatch(from),
  );
  if (occurrences > 1) {
    throw new StudioEditError(
      `Found ${occurrences} occurrences of that text in ${path}. It must be unique — ` +
        "include surrounding lines so the match is unambiguous.",
    );
  }

  const updated =
    match.haystack.slice(0, match.index) + to + match.haystack.slice(match.index + match.length);
  if (updated === match.haystack) {
    throw new StudioEditError(`No change: the replacement is identical to the original in ${path}`);
  }

  return {
    content: bom + restoreEndings(updated, ending),
    diff: formatDiff(match.haystack, updated),
  };
}
