// Copyright 2026 the AAI authors. MIT license.
/**
 * What a reload has to remember BESIDES the key: which MODE started the run.
 *
 * A `runId` names a run for as long as something holds it, and the page holds it
 * in React state — so a refresh loses it while the fan-out carries on
 * transcribing. `useWorkflowSubmit({ key, recover: true })` is the fix; the key
 * itself is `useRunKey()` (`@alexkroman1/aai-ui`), which owns the minting, the
 * storage and the argument for both. What is left here is the value that is
 * this PAGE's own concept — the mode — plus the sentence the page says while a
 * run it did not start is arriving.
 *
 * It is its own module for two reasons, and only the second is about keeping
 * `client.tsx` down to the page's shape:
 *
 * - **A template's spec is what makes its exemplar code true**, and none of this
 *   can be tested from a `client.tsx`. That file ends in a `page()` call and
 *   imports a stylesheet, and this package's suites have no DOM at all: the
 *   vitest `include` matches `.test.ts` and not `.test.tsx`, and the scaffold
 *   declares no React testing library — so a `client.test.tsx` would be
 *   collected by nothing here AND would break `aai test` in a scaffolded
 *   project. Here the decisions are ordinary functions, so `recover.test.ts`
 *   pins them; what only a DOM can show (that the hook adopts the run, once,
 *   and never over a submit) is `aai-ui`'s own suite.
 * - The mode recall has a REAL branch in it: what comes back out of storage is
 *   an untrusted string, and a page that trusted it would index `WORKFLOWS`
 *   with it and start a run by the name `undefined` — a 400 from a value nobody
 *   typed.
 *
 * ## The two values keep the same lifetime, and it is not a coincidence
 *
 * The mode lives in `sessionStorage`, which is the store `useRunKey()` defaults
 * to and the same lifetime as the SDK's own upload recall (`useWorkflowSubmit`
 * remembers the id it minted, so picking the same file again sends only the
 * windows that did not land). All three halves of a reload therefore make the
 * same promise: a mode remembered longer than the key that finds the run would
 * open the desk on a flow with nothing behind it.
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

/** What {@link pendingNote} needs to know about the run in flight. */
export type PendingNoteInput = {
  /**
   * Whether this flow's run can be picked up after a reload at all.
   *
   * False for the streaming flow, and the sentence has to say so — see
   * {@link pendingNote}.
   */
  recoverable: boolean;
  /** Whether THIS load pressed Transcribe. A reload cannot have. */
  startedHere: boolean;
  /** Whether a run has arrived yet, which on a reload means the lookup landed. */
  found: boolean;
};

/**
 * What the desk says while something is in flight — four situations, one line
 * each.
 *
 * The one that earns this function is the first: the streaming flow's run reads
 * the recording as this page sends it, so a reload does not orphan that run, it
 * ENDS it — `workflows/stream.ts` gives an upload that stops growing five
 * minutes (`MAX_IDLE_POLLS`) before it calls the uploader gone and fails the
 * run. A page telling a reader they can close the tab would be wrong in the
 * mode this desk opens in.
 *
 * The other three are the ordinary recovery copy, and the reload case gets its
 * own words deliberately: somebody who did not press the button is owed an
 * explanation for a transcript appearing in front of them, and it is the line
 * that stops them sending the recording again.
 *
 * @param input - See {@link PendingNoteInput}.
 * @returns One sentence, always.
 */
export function pendingNote(input: PendingNoteInput): string {
  const { recoverable, startedHere, found } = input;
  if (!recoverable)
    return "Keep this tab open — the run is reading the recording as this page sends it, so a reload ends the run.";
  if (startedHere) return "Reloading is safe — this page will find the run again.";
  if (!found) return "Looking for a transcript this tab started earlier…";
  return "Still transcribing a recording this tab sent earlier — no need to send it again.";
}
