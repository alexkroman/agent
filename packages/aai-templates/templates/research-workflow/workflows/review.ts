// Copyright 2026 the AAI authors. MIT license.
/**
 * The review wait — the one suspension this desk takes, and the one thing its
 * body and one of its tools have to agree on exactly.
 *
 * `researchFlow` opens the wait with {@link REVIEW_SLEEP_ID} and `file_it_now`
 * ends it by naming the same id, so the two are a pair in the way
 * `recap-workflow/workflows/tokens.ts` describes: a string written twice is a
 * string that drifts once, and the symptom is `wakeUp` answering `0` — which is
 * ALSO what "the run had already moved past its wait" looks like. One module
 * both sides import is what makes those two answers mean different things.
 *
 * It cannot live in `shared.ts` (which imports the body, so the body cannot
 * import it back) and it cannot live in `research.ts` (a tool that imported the
 * body module to read one constant would pull the whole research pass into its
 * graph for a string). A module with no directive is legal under `workflows/`
 * for the reason `prompts.ts` gives: the builder transforms bodies, and this
 * declares data.
 */

/**
 * How long the desk sits on a finished report before filing it.
 *
 * Short enough to watch in `aai dev`. Nothing about the body changes if it is
 * `"6 hours"` — which is the interesting version, and the one a real desk would
 * use; what makes either affordable is that the run is SUSPENDED rather than
 * blocked, so the sandbox is free to exit and the run resumes when it comes due.
 */
export const REVIEW_DELAY_MS = 30_000;

/**
 * What `file_it_now` wakes, and nothing else.
 *
 * `ctx.workflows.wakeUp(runId)` with no ids wakes EVERY sleep the run is
 * holding, which is right for a run with one suspension and wrong the moment
 * there are two — a desk that later grows an approval waitpoint would find "send
 * it now" quietly ending that as well, and the failure would be a report filed
 * without the approval it was waiting for rather than an error anybody sees.
 * Naming the wait costs one field at each end (`SleepOptions.correlationId` in
 * the body, `WakeUpOptions.correlationIds` in the tool) and makes the tool's
 * scope what its description says it is.
 */
export const REVIEW_SLEEP_ID = "review";
