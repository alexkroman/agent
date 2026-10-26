// Copyright 2026 the AAI authors. MIT license.
/**
 * Content search across a workspace's files.
 *
 * Modelled on edge-pi's grep tool (MIT,
 * https://github.com/marcusschiesser/edge-pi) — same shape of input and the
 * same `path:line: text` output — but implemented directly rather than by
 * shelling out to `rg`: a workspace is at most
 * `MAX_WORKSPACE_FILES` strings already in memory, and a sandbox that has no
 * `rg` on its PATH must still be able to search.
 *
 * Without this the agent's only way to find something is to read whole files,
 * which on a multi-file workspace burns context to answer "where is this
 * defined".
 *
 * A catastrophic model-supplied regex cannot be bounded by a timer on the
 * thread running it, so the tool runs the scan in a worker it can terminate
 * ({@link grepWorkspaceBounded}) rather than trusting a pattern analysis nobody
 * can write.
 */

import picomatch from "picomatch";
import { errorMessage } from "../sdk/utils.ts";
import { runEvalWorker } from "./eval-worker.ts";
import { MAX_WORKSPACE_FILES } from "./workspace-files.ts";

/** Matches returned before the result is capped. */
const DEFAULT_LIMIT = 100;
/** Output lines longer than this are elided; the agent can read_file for more. */
const MAX_LINE_LENGTH = 200;
/**
 * Lines longer than this are not matched against at all — a perf guard so a
 * minified or data line doesn't dominate the scan budget. (It is NOT the
 * backtracking bound: catastrophic patterns explode at tens of characters;
 * {@link GREP_TIMEOUT_MS} on a terminable worker is what bounds those.)
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
export class CodingGrepError extends Error {}

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
    throw new CodingGrepError(`Invalid glob ${JSON.stringify(glob)}: ${errorMessage(err)}`, {
      cause: err,
    });
  }
}

function buildMatcher(pattern: string, opts: GrepOptions): RegExp {
  const source = opts.literal ? escapeRegex(pattern) : pattern;
  try {
    return new RegExp(source, opts.ignoreCase ? "i" : "");
  } catch (err) {
    throw new CodingGrepError(
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

/** One hit: the file and the 0-indexed line that matched. */
type GrepHit = [path: string, line: number];

/**
 * The scan itself: every line of every listed file tested against the regex,
 * up to `limit` hits.
 *
 * SELF-CONTAINED on purpose — no reference to anything outside its own body —
 * because {@link grepWorkspaceBounded} ships its source text into a worker
 * thread (`scanFiles.toString()`). One definition serves both the in-process
 * {@link grepWorkspace} and the worker, so the two cannot disagree on which
 * lines are searched. Overlong lines are skipped, not searched — see
 * MAX_SEARCHABLE_LINE, which is passed in for the same reason.
 */
function scanFiles(
  files: Record<string, string>,
  paths: string[],
  source: string,
  flags: string,
  limit: number,
  maxLine: number,
): GrepHit[] {
  const matcher = new RegExp(source, flags);
  const hits: GrepHit[] = [];
  for (const path of paths) {
    const lines = (files[path] ?? "").split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      if (hits.length >= limit) return hits;
      const line = lines[i] ?? "";
      if (line.length <= maxLine && matcher.test(line)) hits.push([path, i]);
    }
  }
  return hits;
}

/** A validated search: what {@link scanFiles} runs and how its hits print. */
type GrepPlan = {
  paths: string[];
  source: string;
  flags: string;
  limit: number;
  context: number;
};

/**
 * Validate the inputs and fix the search's shape. Every refusal the caller
 * can act on (empty pattern, bad regex, bad glob) is thrown from HERE, on the
 * calling thread, so the bounded path reports them exactly as the plain one.
 */
function planGrep(files: Record<string, string>, pattern: string, opts: GrepOptions): GrepPlan {
  if (pattern.length === 0) throw new CodingGrepError("pattern must not be empty");
  const matcher = buildMatcher(pattern, opts);
  const pathFilter = opts.glob ? globMatcher(opts.glob) : null;
  return {
    paths: Object.keys(files)
      .sort()
      .filter((path) => !pathFilter || pathFilter(path)),
    source: matcher.source,
    flags: matcher.flags,
    limit: Math.max(1, Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_WORKSPACE_FILES * 100)),
    context: Math.max(0, opts.context ?? 0),
  };
}

/** Print the hits in grep's output shape. */
function formatHits(files: Record<string, string>, hits: GrepHit[], plan: GrepPlan): string {
  if (hits.length === 0) return "No matches found";
  const out: string[] = [];
  const split = new Map<string, string[]>();
  for (const [path, i] of hits) {
    let lines = split.get(path);
    if (!lines) {
      lines = (files[path] ?? "").split("\n");
      split.set(path, lines);
    }
    emitMatch(path, lines, i, plan.context, out);
  }
  // Say so when results were dropped: a silent cap reads as "that's all there is".
  return hits.length >= plan.limit
    ? `${out.join("\n")}\n\n[Stopped at ${plan.limit} matches.]`
    : out.join("\n");
}

/**
 * Search `files` for `pattern`, in grep's output shape — IN PROCESS.
 *
 * A catastrophic pattern blocks the calling thread for as long as it
 * backtracks; a host that takes model-supplied patterns wants
 * {@link grepWorkspaceBounded}.
 *
 * @throws {CodingGrepError} when the pattern is empty or not a valid regex
 * or glob.
 */
export function grepWorkspace(
  files: Record<string, string>,
  pattern: string,
  opts: GrepOptions = {},
): string {
  const plan = planGrep(files, pattern, opts);
  const hits = scanFiles(
    files,
    plan.paths,
    plan.source,
    plan.flags,
    plan.limit,
    MAX_SEARCHABLE_LINE,
  );
  return formatHits(files, hits, plan);
}

/** Wall-clock cap on one bounded search. */
export const GREP_TIMEOUT_MS = 10_000;

/**
 * The worker body for {@link grepWorkspaceBounded}: {@link scanFiles}'s own
 * source, called on `workerData`. A STRING rather than a sibling file for the
 * reason `run_code`'s worker is one (`aai-guest-core/trial.ts`): the guest
 * harness bundles this module into a single artifact with no second file to
 * start a worker from. The pattern travels as data, never spliced in.
 */
const GREP_WORKER = `
const { parentPort, workerData: d } = require("node:worker_threads");
const scanFiles = ${scanFiles.toString()};
parentPort.postMessage(scanFiles(d.files, d.paths, d.source, d.flags, d.limit, d.maxLine));
`;

/**
 * {@link grepWorkspace} with the scan in a worker thread that is TERMINATED at
 * `timeoutMs` — the form for a model-supplied pattern.
 *
 * A regex match is synchronous and never yields, so a timer on the calling
 * thread cannot interrupt one: `(a+)+$` against forty `a`s and a `!` backtracks
 * for days, and in-process that wedged the WHOLE process — the per-call tool
 * deadline is a promise race whose timer never gets to fire, so in the studio
 * guest every HTTP route, preview session and the host control socket stalled
 * behind one `grep`. `run_code` was the same wedge and got the same cure
 * (`aai-guest-core/trial.ts`), through the same {@link runEvalWorker}: only
 * `terminate()` stops a thread mid-match. One isolate spawn per search is the
 * price.
 *
 * @throws {CodingGrepError} for every refusal {@link grepWorkspace} makes, and
 * when the scan outlives `timeoutMs`.
 */
export async function grepWorkspaceBounded(
  files: Record<string, string>,
  pattern: string,
  opts: GrepOptions = {},
  timeoutMs: number = GREP_TIMEOUT_MS,
): Promise<string> {
  const plan = planGrep(files, pattern, opts);
  // Only the files the glob kept cross the thread boundary.
  const selected: Record<string, string> = {};
  for (const path of plan.paths) selected[path] = files[path] ?? "";
  const hits = await runEvalWorker<GrepHit[]>(
    GREP_WORKER,
    {
      files: selected,
      paths: plan.paths,
      source: plan.source,
      flags: plan.flags,
      limit: plan.limit,
      maxLine: MAX_SEARCHABLE_LINE,
    },
    {
      timeoutMs,
      label: "grep",
      timeoutMessage: new CodingGrepError(
        `grep timed out after ${timeoutMs}ms — the pattern ${JSON.stringify(pattern)} ` +
          "backtracks catastrophically on this workspace. Simplify it (no nested " +
          "quantifiers like (a+)+), or pass literal: true.",
      ),
    },
  );
  return formatHits(files, hits, plan);
}
