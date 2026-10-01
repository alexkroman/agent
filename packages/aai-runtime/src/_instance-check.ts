// Copyright 2026 the AAI authors. MIT license.
/**
 * A process holds ONE copy of this package — and says so when it does not.
 *
 * The runtime's process-wide state is module-level: the metrics sinks
 * (`metrics-sink.ts`), the workflow run context (`workflow/run-context.ts`), the
 * shared run reads (`workflow/run-reads.ts`), the client event feed and the app
 * pool registry. That is correct only while every caller in the process resolves
 * the same module instance, which is what the build arranges: agent bundles
 * IMPORT `@alexkroman1/aai-runtime` rather than inlining it (`RUNTIME_EXTERNAL`,
 * aai-cli's `worker-bundler.ts`), and the guest harness keeps it external too
 * (`aai-guest/tsdown.config.ts`, pinned by `harness/externals.test.ts`).
 *
 * What the build cannot rule out is an INSTALL with two: a project whose
 * `@alexkroman1/aai-runtime` resolved to a different version than the one
 * `@alexkroman1/aai-cli` depends on gets a nested second copy, and so does a
 * worker built by a CLI that still inlined it. Nothing fails then — the sessions
 * run — but a sink registered on one copy hears nothing from the other, and a
 * workflow's progress streams nowhere. So the first copy to load records where it
 * was loaded from, and a copy loaded from anywhere else WARNS, naming both.
 *
 * The identity is the module URL, not the module object: `vi.resetModules()` and
 * vitest's per-file isolation re-evaluate the same file, which is one install
 * and not the failure this reports.
 *
 * @module
 */

/** The process-wide record of where the first copy was loaded from. */
const INSTANCE_KEY = Symbol.for("@alexkroman1/aai-runtime.instance");

type InstanceSlot = { [INSTANCE_KEY]?: string };

/**
 * Record `url` as this process's copy, or warn when another copy got there first.
 * Answers whether `url` is the process's copy.
 *
 * @internal
 */
export function claimRuntimeInstance(
  url: string,
  slot: object = globalThis,
  warn: (message: string) => void = (message) => console.warn(message),
): boolean {
  const record = slot as InstanceSlot;
  const first = record[INSTANCE_KEY];
  if (first === undefined) {
    record[INSTANCE_KEY] = url;
    return true;
  }
  if (first === url) return true;
  warn(
    "@alexkroman1/aai-runtime is loaded TWICE in this process — once from " +
      `${first} and again from ${url}. The two copies share no state: metrics ` +
      "sinks, workflow progress and run context registered on one are invisible " +
      "to the other. Install a single version (dedupe the lockfile so the project " +
      "and @alexkroman1/aai-cli resolve the same @alexkroman1/aai-runtime), and " +
      "rebuild workers with the current CLI so they import the runtime rather " +
      "than inlining it.",
  );
  return false;
}

/**
 * Claim THIS module's copy. Called at the top level of the modules whose state
 * would split (`metrics-sink.ts`, `workflow/run-context.ts`) rather than here: the
 * package declares `"sideEffects": false`, so a bare import of this file is the
 * one thing a bundler may drop.
 *
 * @internal
 */
export function checkRuntimeInstance(): void {
  claimRuntimeInstance(import.meta.url);
}
