// Copyright 2026 the AAI authors. MIT license.
/**
 * Post-write type diagnostics — the profitable half of an LSP, without one.
 *
 * Measured across the studio starter evals, repair rounds are where runs
 * lose their time: the agent writes files, later runs a check or a build,
 * and burns LLM round-trips fixing errors it could have seen at the moment
 * of the write. opencode solves this with a resident language server whose
 * diagnostics ride on every edit result; codex has nothing and leans on the
 * model to run checks. This is the middle: TypeScript 7's native compiler
 * checks a whole studio workspace in ~0.3–0.6s (measured; ~131 MB transient
 * peak), so a plain `tsc --noEmit` after each settled write delivers the
 * same "errors arrive inside the tool result" loop with no resident server
 * process (~218 MB RSS in a memory-capped sandbox), no protocol client, and
 * no lifecycle to manage across npm installs and session re-inits.
 *
 * Two rules, both different from the syntax gate in studio-syntax.ts:
 *
 * - The write is NEVER rejected. A type error is a legitimate intermediate
 *   state — the file the agent writes next may be the fix — so diagnostics
 *   inform the result of a write that already happened.
 * - Diagnostics are best-effort. A slow or broken compiler degrades to the
 *   plain "Wrote …" result; it must not fail or stall the write.
 *
 * Concurrent writes coalesce: the tool descriptions tell the agent to issue
 * independent writes in parallel, and a compiler that started before this
 * caller's write landed on disk cannot vouch for it — so callers arriving
 * mid-run share ONE follow-up run started after the current one settles
 * (`createCoalescingRunner`). Coalescing beats queueing because the check
 * reads the whole tree as it stands: N queued checks would repeat the
 * follow-up's work N times. Worst case a parallel burst costs two checks,
 * never one per file.
 */

import { createCoalescingRunner } from "@alexkroman1/aai/internal";
import pTimeout from "p-timeout";
import { isScriptFile } from "./studio-syntax.ts";

export type TypecheckResult = { ok: true; skipped: boolean } | { ok: false; output: string };
export type TypecheckFn = () => Promise<TypecheckResult>;

/**
 * The diagnostics block to append after a write of `rel`, or undefined when the
 * workspace is clean, the file is not a script, or the check could not run.
 *
 * Named because it is what the tool families are handed: ONE checker, built by
 * `createStudioAgent` and shared, so the coalescing runner below actually
 * coalesces across them.
 */
export type PostWriteDiagnostics = (rel: string) => Promise<string | undefined>;

/**
 * Deadline for one post-write check. Far above the measured ~0.6s so it only
 * fires on a genuinely wedged compiler, and well under the 120s tool
 * deadline so the write result still reaches the model.
 */
const POST_WRITE_TYPECHECK_TIMEOUT_MS = 30_000;

/**
 * Diagnostic lines shown per write. One broken file can emit hundreds of
 * errors, and this message repeats on every write of a repair loop — beyond
 * the cap the count is stated and the batch hint already says "fix them all
 * in one pass". Hints are appended after the cap, so they always survive.
 */
const MAX_DIAGNOSTIC_LINES = 40;

const HINTS_SEPARATOR = "\n\nHints:\n";

/**
 * Build the shared post-write checker for one workspace: returns a
 * diagnostics block to append to a successful write/edit result, or
 * undefined when the workspace is clean (or the check could not run).
 */
export function createPostWriteDiagnostics(
  typecheck: TypecheckFn,
  timeoutMs: number = POST_WRITE_TYPECHECK_TIMEOUT_MS,
): PostWriteDiagnostics {
  // The in-flight compiler may have read the tree before this caller's write
  // landed, so its verdict cannot clear this write — exactly the runner's
  // trailing-run semantics. Each run degrades to undefined on timeout or a
  // thrown checker (never rejects): a broken checker must not break writes
  // (same posture as the syntax gate).
  const runner = createCoalescingRunner<TypecheckResult | undefined>(() =>
    pTimeout(typecheck(), { milliseconds: timeoutMs }).catch(() => undefined),
  );

  return async (rel) => {
    if (!isScriptFile(rel)) return;
    const result = await runner.trigger();
    if (result === undefined || result.ok) return;
    return formatPostWriteDiagnostics(rel, result.output);
  };
}

/** Cap the error body, keeping any trailing Hints section intact. */
function capDiagnostics(output: string): string {
  const hintsAt = output.indexOf(HINTS_SEPARATOR);
  const body = hintsAt >= 0 ? output.slice(0, hintsAt) : output;
  const hints = hintsAt >= 0 ? output.slice(hintsAt) : "";
  const lines = body.split("\n");
  if (lines.length <= MAX_DIAGNOSTIC_LINES) return output;
  return (
    lines.slice(0, MAX_DIAGNOSTIC_LINES).join("\n") +
    `\n… ${lines.length - MAX_DIAGNOSTIC_LINES} more lines — they repeat the codes above.` +
    hints
  );
}

/** The block appended to a write/edit result whose check came back red. */
export function formatPostWriteDiagnostics(rel: string, output: string): string {
  return (
    `\n\nType errors after writing ${rel} — the file WAS saved (do not re-send it ` +
    `unchanged); fix these before running test_agent:\n${capDiagnostics(output.trim())}`
  );
}
