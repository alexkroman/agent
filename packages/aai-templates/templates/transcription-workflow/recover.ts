// Copyright 2026 the AAI authors. MIT license.
/**
 * What a reload has to remember BESIDES the key: which MODE started the run.
 *
 * `useWorkflowSubmit` keeps the correlation key that finds a run again and
 * `<WorkflowPendingNote>` says the sentence for each of its states. What is
 * left is the value that is this PAGE's own concept — the mode — and it is its
 * own module for two reasons:
 *
 * - **A template's spec is what makes its exemplar code true**, and none of
 *   `client.tsx` is reachable from a test: it mounts on import, and this
 *   package's suites have no DOM. Here the decisions are ordinary functions, so
 *   `recover.test.ts` pins them.
 * - The mode recall has a REAL branch in it: what comes back out of storage is
 *   an untrusted string, and a page that trusted it would start a run by a
 *   name the agent never declared — a 400 from a value nobody typed.
 *
 * The mode lives in `sessionStorage`, which is the store the hook's own key
 * defaults to, so the two halves of a reload make the same promise: a mode
 * remembered longer than the key that finds the run would open the desk on a
 * flow with nothing behind it.
 */

/** Where the mode that last submitted lives between loads. */
const MODE_STORAGE = "transcription-workflow:mode";

/**
 * Remember which flow the reader picked, so the next load shows the run it
 * started.
 *
 * Without this the recovery is half-done in a way that reads as broken: the
 * mode resets to the default on a reload, so a recovered classic run sits
 * behind a radio nobody pressed while the page in front of the reader is an
 * empty form — which is the "start a second run" invitation the key exists to
 * remove.
 *
 * @param mode - The mode that is about to submit.
 */
export function rememberMode(mode: string): void {
  try {
    globalThis.sessionStorage?.setItem(MODE_STORAGE, mode);
  } catch {
    // A desk that cannot remember its mode still transcribes; it just opens on
    // the default next time.
  }
}

/**
 * The mode the last load submitted with, if it is still one of the modes.
 *
 * The validation is the point. Storage hands back a string this page wrote
 * SOME version ago — a renamed mode, a hand-edited value, a key another app on
 * the origin happens to share — and the page turns a mode into a workflow NAME.
 * An unchecked value would start a run called `undefined` and answer a 400
 * nobody can explain, so anything not in `valid` falls back.
 *
 * @param valid - The modes this page offers, which is the page's own list
 *   rather than a copy of it.
 * @param fallback - The mode to open on when there is nothing to recall.
 * @returns One of `valid`, always.
 */
export function recalledMode<M extends string>(valid: readonly M[], fallback: M): M {
  try {
    const stored = globalThis.sessionStorage?.getItem(MODE_STORAGE);
    // `find` rather than a cast plus `includes`: the narrowing is then the
    // lookup's own, so there is nothing to keep in step by hand.
    return valid.find((mode) => mode === stored) ?? fallback;
  } catch {
    return fallback;
  }
}
