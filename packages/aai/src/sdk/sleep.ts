// Copyright 2026 the AAI authors. MIT license.
/**
 * Wait `ms` — the one spelling.
 *
 * A repo-wide audit against `dbos-transact-ts`, which declares exactly one
 * (`sleepms` in its `src/utils.ts`, plus two abort-aware variants beside it),
 * found **six** here across five packages, at 22 call sites:
 *
 * ```ts no-check
 * new Promise((resolve) => setTimeout(resolve, ms))            // ×13, inline
 * function sleep(ms) { setTimeout(resolve, ms).unref?.() }     // aai-server/_sleep.ts
 * function delay(ms) { setTimeout(resolve, ms).unref?.() }     // workflow-api-wait.ts
 * function sleep(ms) { … }                                    // host/workflow-notify.ts
 * function delayOrAbort(ms, signal) { … }                      // host/_fake-llm.ts
 * import { setTimeout as sleep } from "node:timers/promises"   // ×4
 * ```
 *
 * The sixth is worth its own sentence, because nothing in this repo could see
 * it. `host/workflow-notify.ts` carried a raw NUL byte in a composite map key
 * (`` `${sessionId}\0${runId}` ``, written as the character rather than the
 * escape). `git grep` reports a file holding one as `Binary file … matches` with
 * no line and no text, and every gate here — guard-invariants,
 * check-escape-hatches — is a `git grep`. So that module was exempt from all of
 * them, silently, and had grown its own `sleep` while nine other rules could not
 * look at it either. It is `\u0000` now, with a comment saying why.
 *
 * Two of those are byte-identical across a package boundary, which is the
 * ordinary kind of duplication. The interesting part is that the five fall into
 * two FAMILIES that differ in a property nothing wrote down and no reader can
 * see at a call site: **whether the test suite can drive the wait.**
 *
 * `vi.useFakeTimers()` replaces the global `setTimeout`; it does NOT patch
 * `node:timers/promises` under this repo's vitest config. Measured — a spec
 * that awaits `nodeSleep(1000)` and then calls
 * `await vi.advanceTimersByTimeAsync(1000)` never sees it resolve. So the
 * spelling silently decides whether a poll loop is observable under virtual
 * time, and the cost of picking the invisible one is already paid in the tree:
 * `aai-cli/_dev-restart.ts` carries an injectable `sleep` seam whose comment
 * ("Injectable so retry specs don't sleep real wall-clock") is a workaround for
 * exactly this, and it is the only one of the three `node:timers/promises`
 * callers that has one. That matters more than it sounds, because
 * `vitest.slow.config.ts` carries no `retry` on any tier: a spec that waits out
 * real milliseconds is a spec that fails first on a contended runner, and the
 * flake then names the timing helper rather than the bug (see "A spec that
 * observes a TIMER runs on virtual time" in the root guide).
 *
 * Hence the global timer, always — which REVERSES a deliberate earlier change
 * ("node:timers/promises for the dev-server listen retry", in the commit that
 * replaced several hand-rolled patterns with Node built-ins). That change was
 * right on its own terms: reaching for the platform's own timer promise instead
 * of hand-rolling one is the same instinct as `Promise.withResolvers()` over a
 * hand-rolled deferred, which the root guide asks for. What it could not know is
 * that this particular built-in is the one the test runner cannot reach, and
 * that the repo would later put its timer-observing specs on virtual time. The
 * seam it grew is the evidence.
 *
 * The rest of the surface is the two things the five spellings disagreed about:
 *
 * - **`unref` is OPT-IN, and it is a claim.** Setting it says "abandoning this
 *   wait is correct" — right for a poll interval in a process an accepted socket
 *   is already holding open (every `aai-server` caller), wrong for a wait that is
 *   the only pending work. An unref'd sleep in `aai login`'s approval poll would
 *   let node exit mid-poll and report success. The default is therefore ref'd,
 *   which is what the four inline copies and all three `node:timers/promises`
 *   callers already were; every converted `aai-server` site passes
 *   `{ unref: true }` so no behaviour moved with the spelling.
 * - **An abort RESOLVES, and the listener comes off on every path.** dbos's
 *   `interruptibleSleep` carries the argument and is the reason this takes a
 *   signal at all: called in a loop against a long-lived signal, a version that
 *   only attaches accumulates one retained closure per iteration. `_fake-llm.ts`
 *   had written that function without the detach. Resolving rather than
 *   rejecting is deliberate too — `node:timers/promises` throws `AbortError` on
 *   abort, so every caller of an abortable sleep would need a `catch` whose only
 *   job is to swallow the abort it asked for.
 *
 * NOT a timeout: there is nothing to race, so `p-timeout` (guard-invariants
 * rule 3) is the wrong tool and a `Promise.race` against this would be the
 * hand-rolled timeout that rule bans. NOT a yield either — a zero-length wait
 * is `flush()` or `tick()` from `host/_test-utils.ts` (rule 4), which say which
 * of the two they meant.
 *
 * Lives in `sdk/` (so it is free of `node:` imports and rides into the browser
 * client) and is published on `@alexkroman1/aai/internal` rather than `/utils`.
 * `/utils` and `/step` are the subpaths a `workflows/*.ts` module imports its
 * step surface from, and the DURABLE wait those files want — the one that
 * SUSPENDS a run and survives a replay — is `ctx.sleep`. A real-timer `sleep` in
 * that autocomplete is a determinism bug one accepted completion away.
 *
 * ## The options type is `SleepTimerOptions`, not `SleepOptions`
 *
 * `ctx.sleep`'s own option bag (`sdk/workflow-ctx.ts`) is the `@public`
 * `SleepOptions`, published on the root barrel AND `/workflow-api`. Two
 * same-named option types one `sleep` apart is a collision an EDITOR resolves,
 * not a reader: an auto-import picks whichever it likes, the import itself
 * type-checks, and the failure arrives later as a bogus "`correlationId` does not
 * exist". `aai-runtime/workflow-replay.ts` imports from both subpaths two lines
 * apart, which is where that would land. This one is `@internal` and named
 * against nothing else, so it is the half that renames.
 *
 * @module sleep
 */

import { isRecord } from "./utils.ts";

/**
 * Options for {@link sleep}.
 *
 * @internal
 */
export type SleepTimerOptions = {
  /**
   * Resolve early, WITHOUT throwing, when this aborts. The listener is removed
   * on every resolution path, so a loop against a session-lifetime signal
   * retains nothing per iteration.
   */
  signal?: AbortSignal;
  /**
   * Don't let the pending timer hold the process open (`timer.unref()`).
   *
   * A claim that abandoning this wait is correct — see the module doc. Absent
   * in a browser, where the method does not exist and the option is inert.
   */
  unref?: boolean;
};

/**
 * Resolve after `ms` milliseconds, or as soon as `opts.signal` aborts.
 *
 * @internal
 */
export function sleep(ms: number, opts: SleepTimerOptions = {}): Promise<void> {
  const { signal, unref } = opts;
  if (signal?.aborted === true) return Promise.resolve();
  return new Promise<void>((resolve) => {
    // Declared before the timer so `onAbort` can name it; the timer callback
    // detaches in the other direction. Either path leaves nothing attached.
    let onAbort: (() => void) | undefined;
    const timer = setTimeout(() => {
      if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    // Guarded rather than `timer.unref?.()`, because in `sdk/` — which carries
    // no `node:` imports and rides into the browser client — `setTimeout` is
    // typed as answering a `number`. That the compiler refuses the optional call
    // here is the boundary working: `unref` is a Node concept, so reaching it
    // from this side is a duck-type and says so. `isRecord` is the sanctioned
    // spelling for one (guard-invariants rule 17), and a `number` is not one.
    if (unref === true && isRecord(timer) && typeof timer.unref === "function") {
      timer.unref();
    }
    if (signal !== undefined) {
      onAbort = (): void => {
        clearTimeout(timer);
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
