// Copyright 2026 the AAI authors. MIT license.
/**
 * `stepReport()` — what a running workflow says about itself, to a page AND to
 * the server log.
 *
 * A run's snapshot carries a status and, once terminal, an output. Between those
 * two there is nothing: a sixty-segment transcription and a one-segment one both
 * read as `running` for the whole fan-out, and an operator tailing the server
 * log sees a workflow app answer requests without ever learning what its steps
 * are doing. Both gaps have the same cause — a step is dispatched separately
 * from the agent bundle, holds no `ToolContext`, and is handed no logger.
 *
 * So a step narrates with one call and it lands in both places:
 *
 * ```ts
 * import { stepReport } from "@alexkroman1/aai/step";
 *
 * export async function transcribeSegment(index: number) {
 *   await stepReport(`Transcribing segment ${index}.`);
 * }
 * ```
 *
 * ## Why a published slot rather than an import
 *
 * The stream half belongs to the host — it owns the run's progress channel and
 * the logger the line also goes to — and this module may not import it:
 * `@alexkroman1/aai/step` is pulled into the browser bundle, and none of that is
 * loadable there. The host publishes a reporter instead — the same `Symbol.for`
 * slot mechanism {@link stepEnv} uses, and for the same reason: the agent bundle
 * carries its own copy of this module, so the publisher and the reader are two
 * module instances in one realm.
 *
 * `host/workflow-report.ts` is the published half, and it is what turns one
 * `stepReport()` into a stream chunk plus a `logger.info` line.
 *
 * ## Two channels, and the second is what makes a run's OUTPUT streamable
 *
 * {@link stepReport} writes a sentence for a person. {@link stepEmit} writes a
 * VALUE for a program, into a stream named by the caller — which is what lets a
 * long fan-out
 * hand over each result as it lands instead of only at the end. They share this
 * module, the slot, and the swallow-every-failure rule; what differs is the
 * destination and whether an operator sees it.
 *
 * ## An UNPUBLISHED slot logs and moves on
 *
 * Which is what makes an exported step callable from its own spec, where there
 * is no run and no server: the line goes to the console and the call resolves.
 * The same rule {@link stepEnv} follows for `process.env`.
 *
 * ## It is BEST EFFORT, always
 *
 * A run must not fail because its narration could not be written — a closed
 * stream, a run that has moved on, a reporter that threw — so every failure here
 * is swallowed. That was already the rule in the three templates that had
 * hand-rolled this helper; it is now the rule in one place.
 */

/**
 * The registry-wide slot. Prefixed with the package name so a second copy of
 * this SDK in the same process shares it rather than shadowing it.
 */
const STEP_REPORTER_SLOT = Symbol.for("@alexkroman1/aai.stepReporter");

/**
 * What a published reporter does with one chunk.
 *
 * Returning a promise is allowed and awaited: the stream write is async, and a
 * step that awaits `stepReport()` should not race the chunk it just wrote
 * against the request that reads it back.
 *
 * One reporter rather than two, because everything except the destination is
 * shared — the swallowed failure, the step metadata, the debug line when a write
 * is lost. `namespace` selects the stream and `log` says whether an operator
 * should see it, which is the only real difference between the two callers.
 *
 * @internal
 */
export type StepReporter = (
  chunk: unknown,
  options?: { namespace?: string | undefined; log?: boolean | undefined },
) => void | Promise<void>;

/** The shape stored in the slot. `undefined` means nothing has published. */
type StepReporterSlot = { [STEP_REPORTER_SLOT]?: StepReporter };

/**
 * Publish the reporter for this process's steps.
 *
 * Called by whatever is about to serve workflows — `createRuntimeServer`, which is the
 * one front door `aai dev`, a self-hosted server and every deployed guest all
 * go through. Publishing again REPLACES, which is what a dev-server restart
 * means; pass `undefined` to unpublish, which is what a spec does when it is
 * done with a fake.
 *
 * @internal — a host concern, exported from `@alexkroman1/aai-runtime`. A step
 * author calls {@link stepReport}.
 */
export function publishStepReporter(reporter: StepReporter | undefined): void {
  if (reporter === undefined) delete (globalThis as StepReporterSlot)[STEP_REPORTER_SLOT];
  else (globalThis as StepReporterSlot)[STEP_REPORTER_SLOT] = reporter;
}

/**
 * Write one progress line for the run this step belongs to.
 *
 * The line reaches two readers: the run's own output stream, which
 * `GET /workflows/runs/:id/stream` serves and `useWorkflowProgress` in
 * `@alexkroman1/aai-ui` renders,
 * and the server log, so an operator watching a deploy can see which step is
 * running without a page open.
 *
 * **Call it from a STEP, never from the workflow body.** A body replays from the
 * top on every resume, so a line written there is re-emitted on each one — the
 * same rule `ctx.db` follows.
 *
 * Failures are swallowed: narration must never fail a run. It resolves either
 * way, so awaiting it is safe and is what keeps the ordering of a step's own
 * lines.
 *
 * @param line - One line of progress, as a reader should see it. Prefer a
 *   sentence naming what is happening and to what (`"Transcribing 0:00–0:58."`)
 *   over a machine token — the page renders these verbatim.
 * @public
 */
export async function stepReport(line: string): Promise<void> {
  const reporter = (globalThis as StepReporterSlot)[STEP_REPORTER_SLOT];
  if (!reporter) {
    // No host in this process — a spec, or a script calling an exported step.
    // The console is the only channel there is, and silence would make a step
    // under test look like it did nothing.
    consoleLine(line);
    return;
  }
  try {
    await reporter(line, { log: true });
  } catch {
    // A run must not fail because its narration could not be written.
  }
}

/**
 * Write one structured chunk into a NAMED stream of this run.
 *
 * The other half of {@link stepReport}, and the split is what each is FOR:
 * `stepReport` writes a sentence for a person, into the run's default stream and
 * the server log. This writes a VALUE for a program — a partial result, as the step produces
 * it — into a stream a reader asks for by name.
 *
 * That is what makes a long run's output streamable rather than only its
 * narration. A run's snapshot carries a status and, once terminal, an output, so
 * a fan-out that has transcribed forty of sixty segments has forty results and no
 * way to hand any of them over. Emitting each one as it lands means a page renders
 * the answer growing instead of a spinner:
 *
 * ```ts no-check
 * import { stepEmit } from "@alexkroman1/aai/step";
 *
 * export async function transcribeSegment(index: number) {
 *   const text = await transcribe(index);
 *   await stepEmit("transcript", { index, text });
 *   return { index, text };
 * }
 * ```
 *
 * ```tsx no-check
 * // The reader, which the SDK already had: one stream per namespace.
 * const { progress } = useWorkflowProgress<{ index: number; text: string }>(runId, {
 *   namespace: "transcript",
 * });
 * ```
 *
 * **The namespace is REQUIRED, and that is the point of the argument.** The
 * default stream is `stepReport()`'s, carrying lines a page renders verbatim —
 * an object written into it comes back as `[object Object]` in the middle of the
 * progress log, which is a trap rather than a decision. A named stream is also
 * how a reader gets ONE kind of chunk per subscription, so
 * `useWorkflowProgress<T>` can be typed at all.
 *
 * **Call it from a STEP, never from the workflow body**, for the reason `stepReport`
 * says: a body replays from the top on every resume, so a chunk written there is
 * re-emitted on each one.
 *
 * Chunks are RETAINED with the run, so a reader that arrives late or reloads gets
 * the whole stream from the beginning rather than only what arrives next.
 *
 * Failures are swallowed, exactly as `stepReport`'s are: a run must not fail
 * because a reader could not be told about a result the run itself has.
 *
 * @param namespace - Which of the run's streams this belongs in. A short,
 *   stable name — a reader subscribes by it.
 * @param chunk - The value, which must survive the run's own serialization.
 * @public
 */
export async function stepEmit<T>(namespace: string, chunk: T): Promise<void> {
  const reporter = (globalThis as StepReporterSlot)[STEP_REPORTER_SLOT];
  if (!reporter) {
    // No host in this process — a spec, or a script calling an exported step.
    // Named and summarized rather than dumped: this is the console, and a chunk
    // may be a whole segment of transcript.
    consoleLine(`${namespace}: ${describeChunk(chunk)}`);
    return;
  }
  try {
    // `log: false` — a structured chunk per item would bury the narration it
    // sits beside in the server log, which is the reader `stepReport` exists for.
    await reporter(chunk, { namespace, log: false });
  } catch {
    // A run must not fail because a reader could not be told.
  }
}

/** One chunk as a console line: short enough to read, long enough to identify. */
function describeChunk(chunk: unknown): string {
  if (typeof chunk === "string") return chunk;
  try {
    return JSON.stringify(chunk) ?? String(chunk);
  } catch {
    // A cyclic or unserializable chunk would not have survived the stream
    // either; saying so beats throwing from a narration helper.
    return String(chunk);
  }
}

/** The fallback channel: `console.error`, where there is a console at all. */
function consoleLine(line: string): void {
  (globalThis as { console?: { error?: (...args: unknown[]) => void } }).console?.error?.(
    `[workflow] ${line}`,
  );
}
