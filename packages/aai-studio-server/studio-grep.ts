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
 * **The pattern is model-controlled input executed on the host**, and JS
 * regexes backtrack: a catastrophic pattern (`(a+)+$` against a line of
 * `a…a!`) goes exponential at a few dozen characters, pinning the event loop
 * of the whole server process — the per-tool `pTimeout` never fires, because
 * the timer can't run while the regex spins. The scan therefore executes
 * inside a `vm` script with a hard `timeout`: V8's TerminateExecution
 * interrupts a mid-backtrack regex, so the worst a hostile pattern costs is
 * `GREP_BUDGET_MS` of main-thread time and the agent gets an actionable
 * error. Note the vm is used purely as a CPU watchdog — no untrusted *code*
 * is evaluated in it (the script below is a fixed string; the pattern is
 * data compiled host-side by `new RegExp`), so "node:vm is not a security
 * boundary" does not apply: nothing is trying to escape.
 */

import vm from "node:vm";
import { errorMessage } from "@alexkroman1/aai";
import picomatch from "picomatch";
import { MAX_STUDIO_FILES } from "./studio-schemas.ts";

/** Matches returned before the result is capped. */
const DEFAULT_LIMIT = 100;
/** Output lines longer than this are elided; the agent can read_file for more. */
const MAX_LINE_LENGTH = 200;
/**
 * Lines longer than this are not matched against at all — a perf guard so a
 * minified or data line doesn't dominate the scan budget. (It is NOT the
 * backtracking bound: catastrophic patterns explode at tens of characters;
 * `GREP_BUDGET_MS` is what bounds those.)
 */
const MAX_SEARCHABLE_LINE = 10_000;
/**
 * Hard main-thread budget for the whole scan, enforced by the vm timeout.
 * A benign regex over a maximal workspace measures low tens of ms; only a
 * backtracking pattern gets anywhere near this.
 */
export const GREP_BUDGET_MS = 500;

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
 * Glob → RegExp via picomatch — full bash-style semantics (`*` within a
 * segment, `**` across segments, `?`, braces, extglobs). `dot: true` because
 * workspace files like `.env` must match `*` the way `path:` output implies.
 * A RegExp rather than picomatch's matcher function so the test runs inside
 * the vm scan under the same budget — a star-heavy glob backtracks too.
 */
function globRegex(glob: string): RegExp {
  try {
    return picomatch.makeRe(glob, { dot: true });
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

/**
 * The scan loop that runs under the vm timeout: every regex execution —
 * glob filter and line matcher alike — happens inside this script, so all of
 * it is interruptible. Returns flat `[fileIndex, lineIndex, …]` pairs; the
 * host formats them (context lines, elision) outside the budget, which is
 * pure string slicing. Fixed source, compiled once — the only per-call data
 * arrives via the context global `data`.
 */
const SCAN_SCRIPT = new vm.Script(
  `(() => {
    "use strict";
    const { files, matcher, globRe, maxSearchable, limit } = data;
    const out = [];
    let remaining = limit;
    outer: for (let f = 0; f < files.length; f += 1) {
      const file = files[f];
      if (globRe !== null && !globRe.test(file.path)) continue;
      const lines = file.lines;
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (line.length > maxSearchable) continue;
        if (!matcher.test(line)) continue;
        out.push(f, i);
        remaining -= 1;
        if (remaining <= 0) break outer;
      }
    }
    return out;
  })()`,
  { filename: "studio-grep-scan.vm" },
);

type ScanFile = { path: string; lines: string[] };

/** Run the scan under the budget; a deadline becomes a StudioGrepError. */
function runScan(
  files: ScanFile[],
  matcher: RegExp,
  globRe: RegExp | null,
  limit: number,
): number[] {
  const context = vm.createContext({
    data: { files, matcher, globRe, maxSearchable: MAX_SEARCHABLE_LINE, limit },
  });
  try {
    return SCAN_SCRIPT.runInContext(context, { timeout: GREP_BUDGET_MS }) as number[];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ERR_SCRIPT_EXECUTION_TIMEOUT") {
      throw new StudioGrepError(
        `Search timed out after ${GREP_BUDGET_MS}ms — the pattern is too expensive ` +
          "(likely catastrophic backtracking). Simplify it, or pass literal: true.",
        { cause: err },
      );
    }
    throw err;
  }
}

/**
 * Search `files` for `pattern`, in grep's output shape.
 *
 * @throws {StudioGrepError} when the pattern is empty, not a valid regex or
 * glob, or exceeds the scan budget.
 */
export function grepWorkspace(
  files: Record<string, string>,
  pattern: string,
  opts: GrepOptions = {},
): string {
  if (pattern.length === 0) throw new StudioGrepError("pattern must not be empty");
  const matcher = buildMatcher(pattern, opts);
  const globRe = opts.glob ? globRegex(opts.glob) : null;
  const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_STUDIO_FILES * 100));
  const context = Math.max(0, opts.context ?? 0);

  const scanFiles: ScanFile[] = Object.keys(files)
    .sort()
    .map((path) => ({ path, lines: (files[path] ?? "").split("\n") }));
  const pairs = runScan(scanFiles, matcher, globRe, limit);

  const out: string[] = [];
  for (let p = 0; p < pairs.length; p += 2) {
    const file = scanFiles[pairs[p] as number] as ScanFile;
    emitMatch(file.path, file.lines, pairs[p + 1] as number, context, out);
  }

  const found = pairs.length / 2;
  if (found === 0) return "No matches found";
  // Say so when results were dropped: a silent cap reads as "that's all there is".
  return found >= limit ? `${out.join("\n")}\n\n[Stopped at ${limit} matches.]` : out.join("\n");
}
