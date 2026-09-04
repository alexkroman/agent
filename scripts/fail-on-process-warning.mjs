// Copyright 2026 the AAI authors. MIT license.
/**
 * Turn an EventEmitter/AbortSignal listener LEAK into a test failure.
 *
 * A vitest `setupFiles` entry, loaded by every project in the repo via
 * `sharedSetupFiles` in `vitest.shared.ts`.
 *
 * ## Why this is a gate and not a warning
 *
 * `MaxListenersExceededWarning` is the one leak detector Node gives for free,
 * and nothing here was reading it. Measured before this file existed: a test
 * that attaches 25 listeners to one emitter PASSES, printing
 *
 *     (node:8760) MaxListenersExceededWarning: Possible EventEmitter memory
 *     leak detected. 11 data listeners added to [EventEmitter].
 *
 * into a scrollback nobody reads — vitest does not fail on it, CI's `dot`
 * reporter buries it, and the leak ships. That is the shape this repo keeps
 * paying for: a signal that exists, is correct, and gates nothing.
 *
 * The signal is already trusted twice over in this tree, which is the argument
 * for enforcing it in tests rather than the argument against.
 * `packages/aai-guest/src/harness-leak-watch.ts` watches it AT RUNTIME in the guest
 * — written because Node warns exactly ONCE per emitter (measured there: 500
 * listeners, one warning, at 11), which made the `streamTail` leak of #1203
 * expensive to diagnose from a log. And
 * `packages/aai/src/host/transports/pipeline-transport.ts` raises the threshold
 * deliberately with `setMaxListeners(SESSION_SIGNAL_MAX_LISTENERS, …)` under a
 * comment calling it "A LEAK threshold, not a capacity one".
 *
 * So a leak that reaches production is now watched, and a leak that a test
 * already provokes is what this closes: #1203's leak was reachable from a
 * suite, and every suite stayed green.
 *
 * ## Why only this ONE warning
 *
 * Failing on every `process.on("warning")` would fold in `DeprecationWarning`
 * and `ExperimentalWarning` from dependencies we do not control, which is how a
 * gate gets muted rather than fixed. This one is different in kind: it can only
 * be emitted by our own `addListener` call, and it has no benign cause. Measured
 * over the whole unit run (536 files, 7998 tests): NINE occurrences, all nine in
 * `packages/aai-guest/src/harness-leak-watch.test.ts`, whose subject IS this warning
 * — see `EXPECTED` below. Every other suite in the repo is clean, so this is an
 * absolute rule in the sense the `guard-invariants` rules at zero are, rather
 * than a ratchet with a baseline to pay down.
 *
 * Widening it later is a deliberate act: add the warning name to `GATED`, and
 * expect to pay for the dependency warnings that come with it.
 */

/**
 * The warning names that FAIL a run. See the module doc for why this is not
 * "every warning".
 */
const GATED = new Set(["MaxListenersExceededWarning"]);

/**
 * The one legitimate reason to emit a gated warning: a suite whose SUBJECT is
 * the warning.
 *
 * `packages/aai-guest/src/harness-leak-watch.test.ts` drives the guest's runtime
 * leak watcher by both synthesizing `process.emit("warning", …)` and attaching
 * 88 real listeners to a real emitter, so it trips this gate nine times by
 * construction — the gate reporting the one test written to exercise exactly
 * this signal. A suite sets the flag at module scope and the check reads it at
 * warning time, which is the ordering `setupFiles` gives (this file runs first).
 *
 * It is deliberately a bare flag rather than an exported helper: this file is a
 * `.mjs` loaded by path, so a `.ts` spec cannot import from it without the
 * build graph reaching into `scripts/`. `vitest-setup-wiring.test.ts` bounds how
 * far it can spread — an opt-out nobody counts is how a gate quietly dies.
 */
const EXPECTED = Symbol.for("aai.expectsProcessWarnings");

/**
 * Marker property identifying our own listener.
 *
 * `setupFiles` runs once per TEST FILE, and a worker runs many files, so a
 * plain `process.on` here would attach one listener per file to the same
 * process — and `process` is itself an EventEmitter with a max of 10. The gate
 * would then trip on ITSELF somewhere around the eleventh test file in a
 * worker, which is a uniquely bad failure: correct code, reported as a leak, by
 * the leak detector.
 *
 * A property on the function rather than a module-level flag or a
 * `globalThis` key, because vitest gives each test file a fresh module
 * registry: a module-level `let installed` is re-initialised per file and
 * proves nothing. Reading a property off the already-attached listeners asks
 * the only authority that spans files — `process` itself — and stays correct
 * however many realms the pool hands out.
 */
const MARK = "__aaiFailOnProcessWarning";

/**
 * Re-raise a gated warning as an error vitest will fail the run on.
 *
 * Thrown from a `queueMicrotask` rather than from this listener directly: a
 * throw inside the `warning` emit would surface at whatever call site happened
 * to add the offending listener, unwinding code that has nothing to do with the
 * leak. Out of band it becomes an uncaught exception, which vitest reports as
 * an unhandled error and exits 1 on — the same path an unobserved promise
 * rejection already takes.
 *
 * @param {Error} warning
 */
function failOnWarning(warning) {
  if (!GATED.has(warning.name)) return;
  if (globalThis[EXPECTED] === true) return;
  const error = new Error(
    `${warning.name}: ${warning.message}\n\n` +
      "A listener was added to an emitter (or an AbortSignal) more times than\n" +
      "its limit allows, which is Node's only built-in leak detector. Either the\n" +
      "listener is never removed — check that every `addListener`/`on` has a\n" +
      "matching `off` on EVERY path, including the error one — or the limit is\n" +
      "genuinely too low for a signal with many legitimate subscribers, in which\n" +
      "case raise it explicitly and say so:\n" +
      "\n" +
      "  setMaxListeners(SESSION_SIGNAL_MAX_LISTENERS, signal);\n" +
      "\n" +
      "See `packages/aai/src/host/transports/pipeline-transport.ts`, which does\n" +
      "exactly that under a comment explaining why the number is what it is.\n" +
      "The stack below is where the offending listener was added.",
    { cause: warning },
  );
  // The warning's own stack points at the `addListener` call — the only useful
  // frame here. A fresh Error would point at this microtask instead.
  if (warning.stack !== undefined) error.stack = warning.stack;
  queueMicrotask(() => {
    throw error;
  });
}
failOnWarning[MARK] = true;

if (!process.listeners("warning").some((listener) => listener[MARK] === true)) {
  process.on("warning", failOnWarning);
}
