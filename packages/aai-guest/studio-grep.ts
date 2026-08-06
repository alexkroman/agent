// Copyright 2026 the AAI authors. MIT license.
/**
 * Content search across a studio workspace.
 *
 * Modelled on edge-pi's grep tool (MIT,
 * https://github.com/marcusschiesser/edge-pi) — same shape of input and the
 * same `path:line: text` output — but implemented directly rather than by
 * shelling out to `rg`. A workspace is at most `MAX_STUDIO_FILES` strings
 * already in memory, and the studio has no shell to shell out to.
 *
 * Without this the agent's only way to find something is to read whole files,
 * which on a multi-file workspace burns context to answer "where is this
 * defined".
 *
 * Runs INSIDE the guest sandbox (the coding agent's own container), so a
 * catastrophic model-supplied regex costs this tenant's sandbox CPU — never
 * another user's turn. The per-tool deadline in studio-tools.ts bounds it.
 */

import { errorMessage } from "@alexkroman1/aai";
import picomatch from "picomatch";
import { MAX_STUDIO_FILES } from "./limits.ts";

/** Matches returned before the result is capped. */
const DEFAULT_LIMIT = 100;
/** Output lines longer than this are elided; the agent can read_file for more. */
const MAX_LINE_LENGTH = 200;
/**
 * Lines longer than this are not matched against at all — a perf guard so a
 * minified or data line doesn't dominate the scan budget. (It is NOT the
 * backtracking bound: catastrophic patterns explode at tens of characters;
 * the per-tool deadline in studio-tools.ts is what bounds those.)
 */
const MAX_SEARCHABLE_LINE = 10_000;

export type GrepOptions = {
  glob?: string | undefined;
  ignoreCase?: boolean | undefined;
  literal?: boolean | undefined;
  context?: number | undefined;
  limit?: number | undefined;
};

/** Thrown for an input the caller can fix (a bad regex); surfaced to the agent. */
export class StudioGrepError extends Error {}

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Glob matching via picomatch — full bash-style semantics (`*` within a
 * segment, `**` across segments, `?`, braces, extglobs). `dot: true` because
 * workspace files like `.env` must match `*` the way `path:` output implies.
 */
export function globMatcher(glob: string): (path: string) => boolean {
  try {
    return picomatch(glob, { dot: true });
  } catch (err) {
    throw new StudioGrepError(`Invalid glob ${JSON.stringify(glob)}: ${errorMessage(err)}`, {
      cause: err,
    });
  }
}

function buildMatcher(pattern: string, opts: GrepOptions): RegExp {
  const source = opts.literal ? escapeRegex(pattern) : pattern;
  try {
    return new RegExp(source, opts.ignoreCase ? "i" : "");
  } catch (err) {
    throw new StudioGrepError(
      `Invalid regex ${JSON.stringify(pattern)}: ${errorMessage(err)}. ` +
        "Pass literal: true to search for it as plain text.",
      { cause: err },
    );
  }
}

const elide = (text: string): string =>
  text.length > MAX_LINE_LENGTH ? `${text.slice(0, MAX_LINE_LENGTH)}…` : text;

/** Emit one match plus its context lines, in grep's `:`/`-` convention. */
function emitMatch(path: string, lines: string[], i: number, context: number, out: string[]): void {
  for (let c = Math.max(0, i - context); c < i; c += 1) {
    out.push(`${path}-${c + 1}- ${elide(lines[c] ?? "")}`);
  }
  out.push(`${path}:${i + 1}: ${elide(lines[i] ?? "")}`);
  for (let c = i + 1; c <= Math.min(lines.length - 1, i + context); c += 1) {
    out.push(`${path}-${c + 1}- ${elide(lines[c] ?? "")}`);
  }
}

/** Search one file; returns how many matches it contributed. */
function grepFile(
  path: string,
  content: string,
  matcher: RegExp,
  context: number,
  remaining: number,
  out: string[],
): number {
  const lines = content.split("\n");
  let found = 0;
  for (const [i, line] of lines.entries()) {
    if (found >= remaining) break;
    // Overlong lines are skipped, not searched — see MAX_SEARCHABLE_LINE.
    if (line.length > MAX_SEARCHABLE_LINE || !matcher.test(line)) continue;
    emitMatch(path, lines, i, context, out);
    found += 1;
  }
  return found;
}

/**
 * Search `files` for `pattern`, in grep's output shape.
 *
 * @throws {StudioGrepError} when the pattern is empty or not a valid regex
 * or glob.
 */
export function grepWorkspace(
  files: Record<string, string>,
  pattern: string,
  opts: GrepOptions = {},
): string {
  if (pattern.length === 0) throw new StudioGrepError("pattern must not be empty");
  const matcher = buildMatcher(pattern, opts);
  const pathFilter = opts.glob ? globMatcher(opts.glob) : null;
  const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_STUDIO_FILES * 100));
  const context = Math.max(0, opts.context ?? 0);

  const out: string[] = [];
  let found = 0;
  for (const path of Object.keys(files).sort()) {
    if (found >= limit) break;
    if (pathFilter && !pathFilter(path)) continue;
    found += grepFile(path, files[path] ?? "", matcher, context, limit - found, out);
  }

  if (found === 0) return "No matches found";
  // Say so when results were dropped: a silent cap reads as "that's all there is".
  return found >= limit ? `${out.join("\n")}\n\n[Stopped at ${limit} matches.]` : out.join("\n");
}
