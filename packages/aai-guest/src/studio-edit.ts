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

type LineEnding = "\r\n" | "\n";

/**
 * Majority line ending. Counted rather than sniffed from the first newline:
 * a mixed-endings file is rewritten in whichever ending dominates instead of
 * whatever its first line happened to use. Ties fall to `"\n"`.
 */
function detectLineEnding(content: string): LineEnding {
  let crlf = 0;
  let lf = 0;
  for (let i = content.indexOf("\n"); i !== -1; i = content.indexOf("\n", i + 1)) {
    if (content[i - 1] === "\r") crlf += 1;
    else lf += 1;
  }
  return crlf > lf ? "\r\n" : "\n";
}

const toLF = (text: string): string => text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

const restoreEndings = (text: string, ending: LineEnding): string =>
  ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;

/** Per-character replacements a model reliably gets wrong when quoting source. */
const CHAR_REPLACEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/[‘’‚‛]/, "'"],
  [/[“”„‟]/, '"'],
  [/[‐‑‒–—―−]/, "-"],
  [/[  -   　]/, " "],
];

function normalizeChar(ch: string): string {
  for (const [pattern, replacement] of CHAR_REPLACEMENTS) {
    if (pattern.test(ch)) return replacement;
  }
  return ch;
}

type NormalizedText = {
  normalized: string;
  /** `map[i]` = index in the original text of the char `normalized[i]` came from. */
  map: number[];
};

/**
 * Normalize away the differences a model reliably gets wrong when quoting
 * source back at us: trailing whitespace, smart quotes, unicode dashes, and
 * exotic spaces. Matching on this form turns "close enough" into a match
 * instead of a failed edit the agent then retries blindly.
 *
 * Index-preserving: replacements are per-char and trailing-whitespace strips
 * are deletions, so every normalized char maps back to exactly one original
 * char. That map is what lets a fuzzy match splice into the *original* text
 * instead of silently rewriting every smart quote in the file (see findText).
 */
function normalizeWithMap(text: string): NormalizedText {
  const out: string[] = [];
  const map: number[] = [];
  let offset = 0;
  const lines = text.split("\n");
  lines.forEach((line, lineIndex) => {
    const trimmed = line.trimEnd();
    for (let i = 0; i < trimmed.length; i += 1) {
      out.push(normalizeChar(trimmed.charAt(i)));
      map.push(offset + i);
    }
    if (lineIndex < lines.length - 1) {
      out.push("\n");
      map.push(offset + line.length);
    }
    offset += line.length + 1;
  });
  return { normalized: out.join(""), map };
}

type Match = {
  /** Replacement region in the original text: `[start, end)`. */
  start: number;
  end: number;
  /** The space the match was found in — for the ambiguity count only. */
  occurrenceHaystack: string;
  occurrenceNeedle: string;
};

/** Locate `needle` in `haystack`, exact first then fuzzy. */
function findText(haystack: string, needle: string): Match | null {
  const exact = haystack.indexOf(needle);
  if (exact !== -1) {
    return {
      start: exact,
      end: exact + needle.length,
      occurrenceHaystack: haystack,
      occurrenceNeedle: needle,
    };
  }

  const { normalized, map } = normalizeWithMap(haystack);
  const fuzzyNeedle = normalizeWithMap(needle).normalized;
  if (fuzzyNeedle.length === 0) return null;
  const fuzzy = normalized.indexOf(fuzzyNeedle);
  if (fuzzy === -1) return null;
  // Map the fuzzy match back into the original text, so the edit splices into
  // the file as written — everything outside the matched region keeps its
  // smart quotes and trailing whitespace byte-for-byte. End is one past the
  // last matched char, so trailing whitespace the needle never covered stays.
  const start = map[fuzzy] as number;
  const end = (map[fuzzy + fuzzyNeedle.length - 1] as number) + 1;
  return { start, end, occurrenceHaystack: normalized, occurrenceNeedle: fuzzyNeedle };
}

/** Count non-overlapping occurrences, in the same space the match was found in. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  return haystack.split(needle).length - 1;
}

const gutter = (n: number, width: number): string => String(n).padStart(width, " ");

/** Line count as a diff sees it: a trailing newline does not add a line. */
function countLines(text: string): number {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.length;
}

/**
 * Main-thread budget for computing the presentation diff. Myers is O(N·D):
 * at the workspace file-size cap, two mostly-different files measure ~7s —
 * and shorter lines push it to minutes — all synchronous, pinning every
 * other request on the process. jsdiff's `timeout` aborts the diff at the
 * deadline (returning undefined); the edit itself has already applied, so
 * the only cost is an elided diff in the tool result.
 */
const DIFF_BUDGET_MS = 500;

/**
 * A unified diff with line numbers, trimmed to `context` lines around each
 * change — the agent gets to see what it actually did, and so does anyone
 * reading the tool row.
 *
 * Hunk grouping and context trimming come from the `diff` package's
 * `structuredPatch`; only the presentation (line-number gutters, `…` elision
 * between hunks) is ours.
 */
function formatDiff(before: string, after: string, context = 3): string {
  const patch = Diff.structuredPatch("", "", before, after, undefined, undefined, {
    context,
    timeout: DIFF_BUDGET_MS,
  });
  if (patch === undefined) {
    return `(diff omitted: the change was too large to diff within ${DIFF_BUDGET_MS}ms — read the file to see the result)`;
  }
  const { hunks } = patch;
  const width = String(Math.max(before.split("\n").length, after.split("\n").length)).length;
  const elision = ` ${" ".repeat(width)} …`;
  const out: string[] = [];

  hunks.forEach((hunk, i) => {
    // Elide what structuredPatch trimmed: before the first hunk when it does
    // not start at line 1, and between hunks (a gap is why they are separate).
    if (i > 0 || hunk.oldStart > 1) out.push(elision);
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    for (const line of hunk.lines) {
      const tag = line[0];
      const text = line.slice(1);
      if (tag === "\\") continue; // "No newline at end of file" marker
      if (tag === "+") {
        out.push(`+${gutter(newLine, width)} ${text}`);
        newLine += 1;
      } else if (tag === "-") {
        out.push(`-${gutter(oldLine, width)} ${text}`);
        oldLine += 1;
      } else {
        out.push(` ${gutter(oldLine, width)} ${text}`);
        oldLine += 1;
        newLine += 1;
      }
    }
  });

  const last = hunks.at(-1);
  if (last && last.oldStart + last.oldLines - 1 < countLines(before)) out.push(elision);
  return out.join("\n");
}

export type EditResult = { content: string; diff: string; replacements: number };

/**
 * Replace every match of `needle`, exact-first-then-fuzzy per occurrence.
 * Resumes the search after each replacement, so a `to` that contains the
 * needle can't be re-matched (no runaway loop) and overlaps are impossible.
 */
function replaceAllMatches(haystack: string, needle: string, to: string): [string, number] {
  const out: string[] = [];
  let rest = haystack;
  let count = 0;
  for (;;) {
    const match = findText(rest, needle);
    if (!match) break;
    out.push(rest.slice(0, match.start), to);
    rest = rest.slice(match.end);
    count += 1;
  }
  out.push(rest);
  return [out.join(""), count];
}

/**
 * The miss message, in one place: both branches below reach it (a `replaceAll`
 * that matched nothing, and a single edit that found nothing) and each carried
 * its own byte-identical copy of the sentence.
 */
function notFound(path: string): StudioEditError {
  return new StudioEditError(
    `Could not find that text in ${path}. It must match the file exactly, ` +
      "including whitespace and newlines — read the file and copy the text verbatim.",
  );
}

/**
 * Replace `oldText` with `newText` in `content` — exactly once, or at every
 * occurrence with `replaceAll` (the rename case, where requiring a unique
 * match would force one edit per call site).
 *
 * @throws {StudioEditError} when the text is absent or (without `replaceAll`)
 * ambiguous — both are cases where guessing would corrupt the file, so the
 * agent is told to try again with more context rather than having an edit
 * applied to the wrong occurrence.
 */
export function applyEdit(
  path: string,
  content: string,
  oldText: string,
  newText: string,
  opts: { replaceAll?: boolean | undefined } = {},
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

  let updated: string;
  let replacements: number;
  if (opts.replaceAll) {
    [updated, replacements] = replaceAllMatches(normalized, from, to);
    if (replacements === 0) throw notFound(path);
  } else {
    const match = findText(normalized, from);
    if (!match) throw notFound(path);

    const occurrences = countOccurrences(match.occurrenceHaystack, match.occurrenceNeedle);
    if (occurrences > 1) {
      throw new StudioEditError(
        `Found ${occurrences} occurrences of that text in ${path}. Include surrounding ` +
          "lines so the match is unambiguous, or pass replaceAll: true to change every one.",
      );
    }

    // Spliced into the original content in both the exact and the fuzzy case,
    // and diffed original-vs-updated — only the matched region ever changes,
    // and the diff shows exactly the bytes that did.
    updated = normalized.slice(0, match.start) + to + normalized.slice(match.end);
    replacements = 1;
  }
  if (updated === normalized) {
    throw new StudioEditError(`No change: the replacement is identical to the original in ${path}`);
  }

  return {
    content: bom + restoreEndings(updated, ending),
    diff: formatDiff(normalized, updated),
    replacements,
  };
}

/**
 * Consecutive `edit_file` misses per file, for the escape hatch below.
 * Cleared by any successful write to that file.
 */
const editMisses = new Map<string, number>();

/** Misses before the agent is told to stop matching and rewrite. */
const MAX_EDIT_MISSES = 2;

/**
 * After repeated failures to match, tell the agent to stop trying.
 *
 * Observed: three "could not find that text" errors on one file, each
 * followed by a re-read and another identical failure, until the step cap.
 * Re-reading does not help when the file's real content differs from what
 * the agent believes it wrote — the only way out is a wholesale rewrite, and
 * nothing was saying so.
 */
export function rewriteHint(rel: string): string {
  const misses = (editMisses.get(rel) ?? 0) + 1;
  editMisses.set(rel, misses);
  if (misses < MAX_EDIT_MISSES) return "";
  return (
    `\n\nThis is ${misses} failed matches on ${rel}. Its real content is not what ` +
    "you expect, so further edits will keep missing: read it once more and " +
    "replace the whole file with write_file instead of matching against it."
  );
}

/** Forget a file's miss count after a successful write. */
export function clearEditMisses(rel: string): void {
  editMisses.delete(rel);
}
