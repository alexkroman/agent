// Copyright 2026 the AAI authors. MIT license.
/**
 * The durable half of the recap desk — and the file the Temporal patterns were
 * ported into.
 *
 * Read `research-workflow/workflows/research.ts` first for the two rules every
 * directive body obeys (replayed from the top, so no live handles and no
 * undurable decisions; step arguments and results cross a queue, so pass an id
 * and not a payload). Both hold here unchanged. What THIS template adds is the
 * three shapes a durable engine exists for, ported from the Temporal TypeScript
 * samples and running against a real provider rather than a stub:
 *
 * | Temporal sample | Ported here as |
 * | --- | --- |
 * | `saga` — `openAccount`'s compensation stack | {@link recapFlow}'s `compensations`, unwound by {@link compensate} |
 * | `polling` — infrequent polling | {@link awaitTranscript}'s loop: one step plus one durable `sleep`, and the BACKSTOP under the callback below |
 * | `timer-examples` — `processOrderWorkflow` | the "still going" note, at {@link PATIENCE_POLLS} turns of the loop or one closed {@link CALLBACK_WINDOW_MS} |
 * | `expense` — `timeoutOrUserAction` | the RETENTION GATE: one `ctx.waitFor` with {@link RETENTION_WINDOW_MS}, three outcomes and a safe default |
 *
 * The voice half — start, query, cancel, and the answer to the gate — is ported
 * in `agent.ts`.
 *
 * ## The provider CALLS BACK, and the poll is what makes that safe
 *
 * AssemblyAI's async API takes a `webhook_url` on submission, so the ordinary
 * case does not need a poll at all: {@link callbackUrl} mints one with
 * `stepWebhookUrl`, {@link submitRecording} hands it over, and the body parks on
 * `ctx.waitFor` until the delivery lands. The run is SUSPENDED throughout — the
 * same as a `sleep`, so this is not a saving on resident process time; what it
 * buys is one status read instead of nine, and a recap that starts being written
 * the second the transcript exists rather than up to fifteen seconds later.
 *
 * **`stepWebhookUrl` is the step-side half of
 * `ctx.workflows.publicWebhookUrl`,** and until it existed this conversion was
 * not available to a workflow at all: the tool-side accessor needs a
 * `ToolContext`, and a body and its steps are handed none. This template could
 * have reached it through its own tools — it has five — but the URL would then
 * have had to travel as run input, which is a shape the three `workflowApp()`
 * templates (no tools at all) could not copy. The step helper is the one both
 * can use.
 *
 * **The poll did not go away, and it must not.** A webhook is one HTTP POST from
 * a third party with no delivery guarantee anyone here controls: AssemblyAI
 * retries ten times at ten-second intervals and then gives up permanently, a
 * deployment may not know its own public URL at all, and a delivery that arrives
 * in the milliseconds before the body reaches its wait is answered `404` and
 * dropped. So the callback is an OPTIMIZATION OVER A RECONCILING READ, never a
 * replacement for one: {@link awaitTranscript} reads the status before it parks
 * and again after, and if nothing ever arrives it degrades to exactly the loop
 * it always was. A template that hung forever on a dropped delivery would be
 * strictly worse than one that polls. That rule generalizes to every event
 * source in this product — the event tells you WHEN to look, and the read is
 * what tells you what happened.
 *
 * **The delivery cannot be the answer even in principle, and that is what makes
 * an unauthenticated callback safe here.** AssemblyAI's payload is
 * `{transcript_id, status}` and nothing else — no text, no error detail — so the
 * run has to `GET` the transcript regardless of who knocked. This body therefore
 * does not read the payload at all: a forged delivery on a guessed token costs
 * exactly one extra status read and changes no decision, because every decision
 * is made from what the provider's own endpoint says under this desk's own
 * credential. That is a better guarantee than a shared secret would be — it
 * holds by construction rather than by a credential somebody has to rotate. See
 * {@link awaitTranscript} for the auth header the provider offers and why this
 * template does not set one.
 *
 * ## The gate is the one that needed a new SDK primitive
 *
 * Temporal's `expense` sample parks a workflow on a signal until a human
 * approves it, and it is the most voice-native pattern in the whole catalog: the
 * caller IS the approver, and the phone IS the signal channel. It could not be
 * written here at all until `ctx.workflows.signal()` existed — the DevKit's only
 * reachable waitpoint was `createWebhook()`, whose URL is minted for a third
 * party with a callback to make, not for the person already on the line. See
 * that method's doc for the token rules; `workflows/tokens.ts` is this template's
 * one derivation of one.
 *
 * ## Why these are worth porting rather than restating
 *
 * All three are the same observation from different angles: **a `try`/`finally`
 * in a tool body is not a transaction.** The process holding it can die, and
 * everything it was going to clean up is then nobody's. Here every one of those
 * moves is a journaled step:
 *
 * - The compensation stack is unwound by CODE THAT IS ITSELF DURABLE. A crash
 *   part-way through the unwind resumes with the already-run compensations
 *   replayed from the journal and re-issues only what is left — which is the
 *   property a `finally` cannot have, and the reason Temporal's saga sample is
 *   the one everybody ports first.
 * - The poll loop's waits are `sleep`, so the sandbox is free to EXIT between
 *   attempts. A twenty-minute transcription costs no resident process; a
 *   `setInterval` in a tool body would hold one and still lose the work on a
 *   redeploy.
 * - The race's timer is journaled too, so "has this been slow?" resolves the
 *   same way on a replay as it did live.
 *
 * ## What is real here
 *
 * Everything the desk claims to do. `submitRecording`, `checkTranscript` and
 * `discardTranscript` are AssemblyAI's pre-recorded API (`POST`, `GET` and
 * `DELETE` on `/v2/transcript`), and `summarize` is a real model call through
 * `stepGenerateJsonOrFail`. The BATCH API is what makes the polling port honest: it
 * answers with a job id in milliseconds and finishes minutes later, so the wait
 * is the provider's, not a `setTimeout` this template chose. (Its sibling
 * `transcription-workflow` takes the other endpoint — the sync one, which answers in
 * the request and pays for it with a hard cap, so its shape is a fan-out rather
 * than a poll.)
 *
 * A step is handed no `ToolContext`, so the key comes from `requireStepEnv`
 * rather than `ctx.env`; under `aai dev` that means it has to be in `.env`, not
 * just your shell.
 */

import type { WorkflowContext } from "@alexkroman1/aai";
import { requireStepEnv, stepFetch, stepReport, stepWebhookUrl } from "@alexkroman1/aai/step";
import {
  FatalError,
  stepFetchOrFail,
  stepGenerateJsonOrFail,
  stepTranscribeSubmitOrFail,
  toStepError,
} from "@alexkroman1/aai/step-errors";
import { errorMessage, omitUndefined } from "@alexkroman1/aai/utils";
import { z } from "zod";
import { retentionToken, transcriptToken } from "./tokens.ts";

/** AssemblyAI's pre-recorded (batch) transcription collection. */
const TRANSCRIPT_ENDPOINT = "https://api.assemblyai.com/v2/transcript";

/** The key a step reads out of the agent env. Declared in `agent.ts`'s `requiredEnv`. */
const API_KEY_ENV = "ASSEMBLYAI_API_KEY";

/**
 * How long the run waits between polls.
 *
 * A `sleep`, so the wait costs nothing: the run is SUSPENDED between attempts
 * and the sandbox may exit. That is what makes the interval a product decision
 * rather than a cost one — fifteen seconds is responsive for a meeting-length
 * file, and the docs' own 1–2 second advice is for a load test with a
 * rate-limit budget to spend.
 */
const POLL_INTERVAL_MS = 15_000;

/**
 * Polls before the desk gives up.
 *
 * A bound rather than a deadline, because it is what the LOOP can enforce with
 * nothing but journaled values: attempt N is attempt N on every replay, where a
 * wall-clock deadline read in the body would move under it. At
 * {@link POLL_INTERVAL_MS} this is twenty minutes, which is far past the
 * turnaround of any recording a phone caller will name.
 */
const MAX_POLLS = 80;

/**
 * How many polls before the desk admits a recording is a long one.
 *
 * The port of Temporal's `processOrderWorkflow`, and the ONE place this port
 * changes shape rather than vocabulary. There the pattern is a `Promise.race`
 * between the work and a timer; here both a `ctx.sleep` and the work's own polls
 * SUSPEND, and a suspend unwinds the stack — so racing them stops the body on
 * whichever suspends first, before the other has been reached. Counting polls
 * says the same thing with journaled values only: attempt N is attempt N on
 * every replay, which is the property {@link MAX_POLLS} already rests on.
 *
 * NINE rather than eight, and the off-by-one is the whole subtlety of counting
 * polls instead of watching a clock: the note goes out at the TOP of a poll, so
 * what has elapsed by then is the sleeps BEHIND it — N-1 of them. At
 * {@link POLL_INTERVAL_MS} that makes this two minutes, the wait the timer named;
 * eight said the same sentence at 1:45, which is a desk calling a recording a
 * long one a quarter of a minute before it is entitled to.
 */
const PATIENCE_POLLS = 9;

/**
 * How long one park on the provider's callback lasts.
 *
 * The same two minutes {@link PATIENCE_POLLS} counts out, and deliberately the
 * same number: whichever arm the run is on, the caller hears "still transcribing"
 * after two minutes of waiting and not before. What differs is only how many
 * times the desk asked the provider to get there — nine reads, or one.
 *
 * **This is the first thing in the template that is a REAL timed race**, which
 * is worth stopping on because {@link PATIENCE_POLLS}'s doc apologises at length
 * for not being one. Temporal's `processOrderWorkflow` races the work against a
 * timer; a poll count can only approximate that, and this file could not do
 * better while both sides of the race were suspending calls. `waitFor(token,
 * { timeoutMs })` IS the race — the delivery or the deadline, journaled as ONE
 * decision — so the ported pattern finally has the shape it has upstream.
 *
 * Two minutes rather than the twenty the loop budgets, because the window is
 * what a DROPPED delivery costs: nothing is lost when it closes, the run simply
 * goes back to reading, so a short window buys most of the saving and bounds the
 * worst case.
 */
const CALLBACK_WINDOW_MS = 120_000;

/**
 * Polls before the desk admits a recording is a long one, on the callback arm.
 *
 * The same off-by-one {@link PATIENCE_POLLS} explains, one window instead of
 * eight sleeps: the note goes out at the TOP of a poll, so what has elapsed by
 * then is the waiting BEHIND it. Attempt 2 is the first turn with a whole closed
 * {@link CALLBACK_WINDOW_MS} behind it, which is the two minutes.
 */
const PATIENCE_POLLS_WITH_CALLBACK = 2;

/**
 * How long the desk holds the transcript waiting for an answer.
 *
 * The port of `timeoutOrUserAction`: Temporal races a `condition()` against a
 * timeout, this passes the window to `ctx.waitFor` as `timeoutMs`, and both have
 * THREE outcomes — approved, declined, nobody answered. A parameter rather than
 * a race for the reason {@link PATIENCE_POLLS} gives, and it is the better shape
 * anyway: the deadline is journaled once, so a replay cannot extend the window,
 * and the engine CLOSES the hook when it shuts so a late answer cannot be taken.
 * The run is suspended throughout, so a caller who hangs up costs nothing.
 *
 * Two minutes because a caller is on the line; a desk whose approver is on email
 * would write two days and nothing else in this file would change.
 */
const RETENTION_WINDOW_MS = 120_000;

/** Every HTTP call's deadline. `fetch` has none of its own, and a hung step never ends. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Transcript characters handed to the model.
 *
 * The pass-an-id-not-a-payload rule meeting the case where the payload IS the
 * work — the same bound `link-digest` puts on article text, for the same
 * reason: it has to cross the queue, so it is capped rather than trusted.
 */
const MAX_TRANSCRIPT_CHARS = 24_000;

/** Points a recap is reduced to. */
const POINTS = 3;

/**
 * The shape the model must answer in.
 *
 * `stepGenerateJsonOrFail` validates against this and throws PLAINLY when the reply
 * misses, which is the retry policy in one distinction: a model that answered in
 * prose may answer correctly next time, where a 401 will not. `spoken` is the
 * field this template exists for — without it the announced turn has nothing to
 * read down the phone — so it is required rather than defaulted.
 */
const RecapReply = z.object({
  headline: z.string().min(1),
  points: z.array(z.string()).min(1),
  spoken: z.string().min(1),
});

/** What one finished recap is. Small and JSON-shaped, like every step result. */
export type Recap = {
  url: string;
  headline: string;
  points: string[];
  /** One sentence a phone call can carry — what the announced turn reads out. */
  spoken: string;
  /** The recording's length, as the provider measured it. */
  minutes: number;
};

/** How the retention gate ended — the three outcomes, named. */
export type Retention = {
  /** Whether the transcript is still on the account. */
  kept: boolean;
  /** False when the window elapsed with nobody answering. */
  answered: boolean;
};

/** A transcript job, as the provider's own status endpoint reports it. */
export type TranscriptState = {
  status: "queued" | "processing" | "completed" | "error";
  text?: string;
  error?: string;
  audioDuration?: number;
};

/**
 * The four statuses this desk knows how to act on.
 *
 * Declared as a schema rather than checked with a `!==` chain because the union
 * IS the provider's contract with this template — see {@link checkTranscript},
 * which reads it as a value the saga branches on — and a schema is the one
 * spelling that both narrows the type and names the four in the error.
 */
const TranscriptStatus = z.enum(["queued", "processing", "completed", "error"]);

/**
 * The poll response, as much of it as this desk reads.
 *
 * **The three optional fields DEGRADE and the status does not**, which is the
 * whole reason each one is spelled differently. A provider that answers
 * `"text": null` on a job still running, or drops `audio_duration` from a
 * failed one, is describing a job this desk can still act on — so a field of
 * the wrong type is `undefined` (`.catch`) and an absent one stays absent. A
 * status outside the four is the opposite: nothing downstream knows what to do
 * with it, and polling to the bound and failing with the wrong reason is worse
 * than stopping here. So a bad status fails the parse and
 * {@link checkTranscript} turns that into a sentence.
 *
 * `audio_duration` is `z.number()` rather than a coercion, and zod 4's
 * `z.number()` refuses `NaN` and both infinities — the `Number.isFinite` test
 * the hand-written reader carried, which is what stops a non-finite duration
 * reaching `Math.round(… / 60)` in {@link summarize}.
 */
const TranscriptBody = z.object({
  status: TranscriptStatus,
  text: z.string().optional().catch(undefined),
  error: z.string().optional().catch(undefined),
  audio_duration: z.number().optional().catch(undefined),
});

/**
 * The status to NAME when {@link TranscriptBody} refused the body.
 *
 * Reporting the value is the job, so nothing here may throw a second time while
 * reporting the first. `.catch({})` absorbs every shape that is not "an object
 * with a string status" — a body that is not an object at all, a `status` that
 * is a number — and each then arrives in the sentence as the word "undefined",
 * which is a truthful "the provider sent something this desk cannot read" and
 * the same thing the per-field read this replaced said. That `.catch` is also
 * what makes `.parse` legal at the one call site: there is no input left for it
 * to throw on.
 */
const ReportedStatus = z
  .object({ status: z.string().optional() })
  .catch({})
  .transform((body) => body.status);

/**
 * One undo, and the name it goes by when it fails.
 *
 * Ported field-for-field from Temporal's `saga` sample, whose `Compensation` is
 * `{ message, fn }`. The label is not decoration: a compensation that fails is
 * SWALLOWED (see {@link compensate}), so the label is the only thing that says
 * what was left behind.
 */
export type Compensation = { label: string; undo: () => Promise<void> };

/**
 * Transcribe a recording, write it up, and leave nothing behind if it fails.
 *
 * Whatever this returns is what a completed run reports as `output` — which
 * `agent.ts` reads back down the phone, so it is shaped for an ear rather than
 * a page.
 */
export async function recapFlow(input: { url: string; requestedBy: string }, ctx: WorkflowContext) {
  // The compensation stack, newest first — `unshift` after each successful
  // acquisition, exactly as Temporal's `openAccount` does. Registering the undo
  // AFTER the step it undoes is the whole discipline: a step that never
  // succeeded has nothing to reverse, and an undo registered before it would
  // reverse a transcript id that does not exist.
  const compensations: Compensation[] = [];

  try {
    // The token this run's callback URL is minted for, and the one
    // `awaitTranscript` parks on — derived from the run's own input in ONE place
    // so the URL the provider is given and the string the body waits on cannot
    // drift. They are separated by a third party on the public internet, which
    // is as far apart as two halves of a contract get.
    const nudge = transcriptToken(input.requestedBy);
    // `callbackUrl` is evaluated INSIDE the step's function, so it runs once —
    // on first execution — and never on a replay, which returns the journaled
    // result without calling this at all. That is what makes the mint a
    // journaled decision rather than one re-taken on every walk.
    const job = await ctx.step("submitRecording", () =>
      submitRecording(input.url, callbackUrl(nudge)),
    );
    compensations.unshift({
      label: `transcript ${job.id}`,
      undo: () => ctx.step("discardTranscript", () => discardTranscript(job.id)),
    });

    // `job.callback` rather than a fresh mint: the branch has to come out of the
    // JOURNAL, or a redeploy mid-run could flip it — see {@link submitRecording}.
    const transcript = await awaitTranscript(job.id, ctx, job.callback ? nudge : undefined);

    const recap = await ctx.step("summarize", () => summarize(input.url, transcript), {
      // Was `summarize.maxRetries = 5` — five retries after the first attempt.
      maxAttempts: 6,
    });
    const retention = await askWhetherToKeep(input.requestedBy, job.id, compensations, ctx);
    return { ...recap, ...retention, requestedBy: input.requestedBy };
  } catch (err) {
    // **A suspension cannot arrive here, and it once could.** The body above
    // WAITS three ways — `awaitTranscript` parks on the provider's callback,
    // then sleeps between polls, and the gate waits for an answer — and each of
    // those used to suspend by THROWING, so it landed in this catch. This saga
    // is the code that paid for it: the first poll that had to wait unwound the
    // compensation stack, DELETED the transcript the run was waiting for,
    // journaled the deletion as successful and re-threw, and the engine saw its
    // own signal come back out and recorded the run as healthily suspended. The
    // data was gone and every signal said fine.
    //
    // The guard that lived here (`if (isWorkflowSuspend(err)) throw err;`) is
    // gone because the hazard is: a wait now hands back a promise that never
    // settles, so a parked body does not reach a `catch` at all. This block sees
    // step failures, and nothing else.
    //
    // The saga's whole point. Everything acquired above is released, in reverse,
    // before the failure is re-thrown — and because each undo is a STEP, a crash
    // during the unwind resumes with the finished ones replayed from the journal
    // rather than run twice.
    await compensate(compensations, errorMessage(err), ctx);
    throw err;
  }
}

/**
 * Poll one transcript job until it settles.
 *
 * A body-side helper, not a step: it `sleep`s, and a step cannot — a step runs
 * to completion in a worker, where the body is what may suspend. Splitting it
 * out keeps `recapFlow` readable and costs nothing: `ctx` is an ordinary value,
 * so a helper handed one issues real steps. Note the occurrence counter is per
 * RUN and not per function, so a name used here may not also be used in the body
 * — the two call sites would alias onto one journal entry.
 *
 * The loop is deterministic despite looking like it is not: every branch turns
 * on a journaled step result or on a journaled input field, so a replay takes
 * the same number of turns it took live.
 *
 * ## Read first, then park ONCE, then read on a timer
 *
 * `nudge` is the callback token when `request_recap` managed to mint a URL, and
 * `undefined` otherwise — in which case every line below behaves exactly as it
 * did before there was a callback at all.
 *
 * The order matters and each part of it is paid for:
 *
 * - **The first read happens BEFORE the park**, so a job that finished while the
 *   submit response was in flight, or a delivery that arrived in the milliseconds
 *   before this body reached its wait and was dropped, costs nothing.
 * - **The park happens ONCE, on the first turn only, and it HAS to.** A hook
 *   token may be claimed at most once per run: `claimHook` (both journal
 *   backends) throws `token … is already held by run …` for a second claim under
 *   a different occurrence key, and the token is given back only when the run
 *   goes TERMINAL — so a `ctx.waitFor` written inside this loop would fail the
 *   second time round. That is not a hypothetical. The comment block at
 *   `aai-runtime/workflow-journal-memory.ts:140-148` records this template
 *   getting it wrong once already: a `claimHook` conflict is a throw and a throw
 *   is not a suspend, so `recapFlow`'s `catch` treated it as a failed run, ran
 *   the compensation stack and DELETED the transcript. A template that teaches
 *   the wrong nesting here costs somebody their data.
 * - **Every later turn is the plain cadence**, because a delivery that has not
 *   arrived within {@link CALLBACK_WINDOW_MS} is one to stop counting on. The
 *   loop from there is the `polling` port, unchanged, and it is what finishes the
 *   run whether the delivery was late, dropped, never sent, or forged.
 *
 * **The payload is not read, and that is the security argument.** `waitFor` is
 * called for its EDGE — "something happened, go look" — and the answer comes
 * from {@link checkTranscript} under this desk's own credential, so nothing a
 * caller could POST to the public callback route changes an outcome. AssemblyAI
 * does offer `webhook_auth_header_name`/`webhook_auth_header_value`, and this
 * template sets neither: the receiving route
 * (`/.well-known/workflow/v1/webhook/:token`) authorizes on the TOKEN and reads
 * no other header, so a header set here would be sent and ignored — security
 * theatre, and worse than none because it reads as a control.
 */
export async function awaitTranscript(
  id: string,
  ctx: WorkflowContext,
  nudge?: string,
): Promise<TranscriptState> {
  // Which turn says "still going". A pure function of `nudge`, which the body
  // derived from a journaled step result, so a replay picks the same turn.
  const patienceAt = nudge === undefined ? PATIENCE_POLLS : PATIENCE_POLLS_WITH_CALLBACK;

  for (let attempt = 1; attempt <= MAX_POLLS; attempt++) {
    const state = await ctx.step("checkTranscript", () => checkTranscript(id));
    if (state.status === "completed") return state;
    if (state.status === "error") {
      // The provider's own terminal answer. A plain `Error`, not a
      // `FatalError`: this is the BODY, and a body's throw is never retried —
      // `FatalError` is the vocabulary for telling the ENGINE not to retry a
      // STEP, and using it here would claim a distinction that does not exist.
      throw new Error(`The provider could not transcribe that recording: ${state.error}`);
    }
    // Once, at the point the timer used to fire — which is the top of the poll
    // that follows two minutes of waiting, see {@link PATIENCE_POLLS} for the
    // off-by-one. `attempt` is a journaled-value function, so a replay says it
    // at the same turn or not at all.
    if (attempt === patienceAt) {
      await ctx.step("noteSlow", () =>
        note("Still transcribing — this is a long one. I'll keep going."),
      );
    }
    // Both arms SUSPEND — nothing is resident while either waits — and the only
    // difference is what can end the wait early. The callback park is first-turn
    // only; see this function's doc for why it cannot be every turn.
    if (attempt === 1 && nudge !== undefined) {
      // The payload is DISCARDED on purpose: this waits for the edge, and the
      // read at the top of the next turn is what establishes the fact.
      await ctx.waitFor(nudge, { timeoutMs: CALLBACK_WINDOW_MS });
    } else {
      await ctx.sleep("poll", POLL_INTERVAL_MS);
    }
  }
  throw new Error(`Gave up on that recording after ${MAX_POLLS} checks.`);
}

/**
 * Ask the caller whether the transcript stays on file, and act on the answer.
 *
 * The port of Temporal's `timeoutOrUserAction`, and a body-side helper for the
 * same reason {@link awaitTranscript} is: it waits, which only a body may do —
 * so it takes the `ctx`.
 *
 * The default is DELETE, which is what makes the timeout meaningful. A gate
 * whose no-answer branch keeps the data is not a gate — it is a prompt with a
 * grace period — and for a desk holding transcripts of other people's meetings
 * the safe default is the one that leaves nothing behind.
 */
export async function askWhetherToKeep(
  requestedBy: string,
  transcriptId: string,
  compensations: Compensation[],
  ctx: WorkflowContext,
): Promise<Retention> {
  await ctx.step("noteGate", () =>
    note(
      "Recap ready. Keep the transcript on file, or delete it? Deleting in two minutes otherwise.",
    ),
  );

  // ONE call, not a race — and the ordering worry the DevKit version opened with
  // is gone with it. `createHook()` registered nothing until the workflow
  // suspended, so a caller's answer could reach a token no hook owned yet and be
  // told "nobody is listening", indistinguishable from being late; hence the
  // `getConflict()` claim on the line above it. `ctx.waitFor` registers the
  // token BEFORE it suspends, by construction, because registering it is how it
  // knows what to wait for.
  const answer = await ctx.waitFor<{ keep: boolean }>(retentionToken(requestedBy), {
    timeoutMs: RETENTION_WINDOW_MS,
  });

  if (answer?.keep === true) return { kept: true, answered: true };
  await ctx.step("discardOnDecline", () => discardTranscript(transcriptId));
  // Drop the undo now that the run has DONE what it undoes. Leaving it would be
  // harmless (`discardTranscript` treats a 404 as success, as every compensation
  // must) and would still be wrong to read: an unwind that reverses something
  // already gone tells whoever is watching the log a story that did not happen.
  compensations.shift();
  return { kept: false, answered: answer !== undefined };
}

/**
 * Run every registered undo, newest first, swallowing failures.
 *
 * Ported from the `compensate` in Temporal's saga sample, including the part
 * that reads like a bug and is not: **a failing compensation must not replace
 * the original error.** The run failed for a reason, the caller needs that
 * reason, and an undo that also failed is a second-order problem — so it is
 * reported and stepped over rather than thrown. The `label` is what makes that
 * report actionable.
 */
export async function compensate(
  compensations: Compensation[],
  because: string,
  ctx: WorkflowContext,
): Promise<void> {
  if (compensations.length === 0) return;
  // The narration is a STEP like every other, so an unwind interrupted by a
  // crash resumes with the lines already said replayed from the journal rather
  // than said twice. Each undo is a step too — registered as one by whoever
  // stacked it — which is what makes an interrupted unwind resumable at all.
  await ctx.step("noteUnwind", () =>
    note(`Recap failed (${because}) — undoing ${compensations.length} step(s).`),
  );
  for (const compensation of compensations) {
    try {
      await compensation.undo();
    } catch (err) {
      await ctx.step("noteUndoFailed", () =>
        note(`Could not undo ${compensation.label}: ${errorMessage(err)}`),
      );
    }
  }
}

// ---- Steps ------------------------------------------------------------------

/**
 * Hand the recording to the provider.
 *
 * Returns in milliseconds with a job id — the batch API's whole shape, and what
 * makes the wait below a real wait rather than a simulated one.
 *
 * `webhookUrl` is where the provider should POST when the job settles, and
 * {@link callbackUrl} is what produces it. The body passes the result IN rather
 * than this minting it, which keeps every HTTP decision in a function a spec can
 * call with a plain string — and keeps the mint in one place.
 *
 * **It answers `callback` as well as `id`, and that is a determinism
 * requirement rather than a convenience.** Whether a callback was registered
 * decides whether {@link awaitTranscript} parks on a hook, and a body may only
 * branch on values that come out of the JOURNAL — so the fact is returned by the
 * step that established it. Reading it in the body instead would re-evaluate it
 * on every replay, and a redeploy that changed the deployment's public URL
 * mid-run would flip the branch: the walk would then look for a `waitFor` the
 * journal never recorded, or skip one it did.
 */
export async function submitRecording(
  url: string,
  webhookUrl?: string,
): Promise<{ id: string; callback: boolean }> {
  await stepReport(`Submitting ${new URL(url).hostname} for transcription…`);

  // `stepTranscribeSubmitOrFail` owns the endpoint, the raw-key auth, the
  // PLURAL `speech_models` field and the failure classification — the
  // `Classified` suffix being that last part: it is `stepTranscribeSubmit` with
  // `throwStepError` already applied, so a provider refusal stays terminal and a
  // rate limit waits out the delay the provider itself named. `speaker_labels`
  // is this desk's own request, which is what `params` is for — the async API's
  // surface is large and the SDK deliberately does not mirror it, and
  // `webhook_url` is a second field on the same passthrough.
  //
  // No `omitUndefined` here, unlike `checkTranscript` below, and the difference
  // is which boundary the value crosses: `params` is serialized, and
  // `JSON.stringify` drops a property whose value is `undefined` — so an absent
  // callback is an absent KEY on the wire, which is what the provider needs.
  // What must not creep in is a `?? null` or a `?? ""` to "be explicit": either
  // one puts the key back, and a provider handed a null for a URL is entitled to
  // refuse the whole submission.
  const job = await stepTranscribeSubmitOrFail(url, {
    params: { speaker_labels: true, webhook_url: webhookUrl },
  });
  return { id: job.id, callback: webhookUrl !== undefined };
}

/**
 * The URL the provider should POST to when this run's transcript is ready, or
 * `undefined` when this deployment cannot offer one.
 *
 * `stepWebhookUrl` (`@alexkroman1/aai/step`) is the step-side half of
 * `ctx.workflows.publicWebhookUrl` — one concept, two surfaces — and it exists
 * because a workflow body and the steps it calls are handed no `ToolContext`.
 * Note it cannot be replaced by `requireStepEnv("AAI_PUBLIC_BASE_URL")`: the
 * public base URL is a boot parameter of the DEPLOYMENT, living in the guest's
 * exec env, while the step env is the tenant's own `.env` and
 * `aai secret put` keys — so that read is `undefined` in production precisely
 * where the value exists.
 *
 * **It THROWS rather than answering `undefined`, and catching it is the whole
 * job of this function.** A callback URL has no legitimate default — it is
 * either the one a third party can reach or it is a lie — so the SDK refuses to
 * invent one. What a template must not do is let that throw reach the step: the
 * recap would fail over a missing optimization. So the throw is converted to
 * "no callback", which puts the run on the poll arm it used to be on always.
 *
 * The cases with no usable URL are a self-hosted server started without
 * `publicUrl`, any spec (which publishes no minter), and **local development
 * either way**: `aai dev`'s origin is a `localhost` one, so it either throws or
 * mints a URL no third party can dial. So a local run always exercises the poll
 * arm. Point a tunnel at the dev server's BACKEND port — the Vite port a
 * developer opens does not proxy `/.well-known/` — and set `PUBLIC_URL` to it to
 * exercise the callback at all.
 */
export function callbackUrl(token: string): string | undefined {
  try {
    return stepWebhookUrl(token);
  } catch {
    return undefined;
  }
}

/**
 * Read the job's status once.
 *
 * One poll is one step, so each attempt is journaled on its own: a run that dies
 * mid-wait resumes knowing what the last answer was instead of starting the
 * recording over.
 *
 * **Deliberately NOT `stepTranscribePoll`, though its sibling above did move to
 * the SDK.** That helper answers `done` and THROWS on a job the provider gave
 * up on, which is the right shape for a flow whose only question is "is the
 * text ready". This desk's question is different: `status` is a VALUE here,
 * read by the Query port (`recap_status`) while the run is still going, and an
 * `error` status is the branch that unwinds the saga's compensation stack
 * rather than a failure to propagate. Converting this would trade a documented
 * state machine — the thing this template is actually about — for a throw.
 * The provider's status union is the template's subject, so it stays in the
 * template.
 */
export async function checkTranscript(id: string): Promise<TranscriptState> {
  const response = await request(`${TRANSCRIPT_ENDPOINT}/${id}`);
  const body = await response.json();
  // `safeParse`, not `parse`: the only shape this desk refuses is an
  // unrecognised status, and it owes that a sentence naming what arrived rather
  // than a zod issue about an enum.
  const parsed = TranscriptBody.safeParse(body);
  if (!parsed.success) {
    throw new Error(
      `The provider reported an unknown transcript status: ${String(ReportedStatus.parse(body))}`,
    );
  }

  await stepReport(`Transcript ${parsed.data.status}.`);
  return {
    status: parsed.data.status,
    // `omitUndefined` rather than a spread-ternary per field: under
    // `exactOptionalPropertyTypes` an absent field and a field set to
    // `undefined` are different types, and this is the SDK's one spelling for
    // the difference. Still needed after the schema, and for a reason worth
    // knowing: an ABSENT field is absent from zod's output too, but a field
    // whose value the schema `.catch`-ed to `undefined` is PRESENT and holding
    // `undefined` — and this result crosses a queue, where such a key does not
    // survive the trip.
    ...omitUndefined({
      text: parsed.data.text,
      error: parsed.data.error,
      audioDuration: parsed.data.audio_duration,
    }),
  };
}

/**
 * Delete the transcript this run created.
 *
 * The compensation, and a real one: `DELETE /v2/transcript/:id` removes the
 * transcribed text from the account. That matters for a desk that handles call
 * recordings — a run that failed half-way has no business leaving a transcript
 * of somebody's meeting sitting in an account nobody is going to read.
 *
 * A `404` is SUCCESS here, which is the property every compensation needs: the
 * undo has to be safe to run against a world where it already happened, because
 * a replay is exactly that world.
 */
export async function discardTranscript(id: string): Promise<void> {
  await stepReport(`Discarding transcript ${id}.`);
  // Not through `request` above, because a 404 is a SUCCESS here — see below.
  // `stepFetch` for the same reason it does; only the status handling differs.
  const response = await stepFetch(`${TRANSCRIPT_ENDPOINT}/${id}`, {
    method: "DELETE",
    headers: { authorization: requireStepEnv(API_KEY_ENV) },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status === 404) return;
  if (!response.ok) {
    throw toStepError(
      response,
      `DELETE ${TRANSCRIPT_ENDPOINT}/${id} failed: HTTP ${response.status}`,
    );
  }
}

/**
 * Reduce a transcript to something worth saying out loud.
 *
 * Separate from the polling on purpose, and for the same reason `link-digest`
 * splits its fetch from its summary: a rate-limited model call replays the whole
 * transcription — twenty minutes of provider time, already paid for — out of the
 * journal instead of submitting the recording again.
 */
export async function summarize(url: string, transcript: TranscriptState): Promise<Recap> {
  await stepReport("Writing the recap.");

  const text = (transcript.text ?? "").slice(0, MAX_TRANSCRIPT_CHARS);
  if (text.trim() === "") {
    // Not transient: the same completed transcript holds the same nothing on
    // every attempt. Silence, or an audio file with no speech in it.
    throw new FatalError("That recording came back with no speech in it.");
  }

  // `stepGenerateJsonOrFail` unwraps the fence a model puts around JSON
  // however firmly it is told not to, parses it, and validates it — all four
  // things this step used to re-derive. The `Classified` half is what makes a
  // terminal gateway failure (a bad key, a rejected request) stop rather than
  // burn the remaining attempts, where a reply that missed the SHAPE throws
  // plainly and retries.
  const parsed = await stepGenerateJsonOrFail(text, {
    schema: RecapReply,
    system:
      "You write up recordings for someone who will hear the result on a phone call. " +
      `Reply with JSON only: {"headline": string, "points": string[], "spoken": string}. ` +
      `Give exactly ${POINTS} points. "spoken" is ONE sentence, under 30 words, ` +
      "written to be read aloud. No markdown fence, no preamble.",
  });

  return {
    url,
    headline: parsed.headline,
    points: parsed.points.slice(0, POINTS),
    spoken: parsed.spoken,
    minutes: Math.round((transcript.audioDuration ?? 0) / 60),
  };
}

/**
 * Say one line into the run's progress channel.
 *
 * A step for one reason: the body REPLAYS, so a `stepReport()` written there is
 * re-emitted on every resume. Everything the body itself wants to narrate —
 * the slow-recording note, the unwind — comes through here, and `agent.ts`'s
 * `recap_progress` is what reads it back down the phone.
 */
export async function note(line: string): Promise<void> {
  await stepReport(line);
}

// ---- HTTP -------------------------------------------------------------------

/**
 * One authenticated request to the pre-recorded API, with this desk's retry
 * policy on it.
 *
 * Note the header is a bare key: AssemblyAI's `authorization` takes the key
 * itself, with no `Bearer` prefix.
 */
async function request(url: string): Promise<Response> {
  // Through `stepFetch`, not `fetch`: it pins HTTP/1.1, so several concurrent
  // runs (and this workflow POLLS, so one run is many requests) get a socket
  // each rather than N streams on one connection — and a connection failure
  // arrives as a `StepTransportError` naming its cause instead of a bare
  // `TypeError: fetch failed`, which for a template whose whole subject is
  // durability is the difference between a diagnosable resume and a mystery.
  // `sdk/step-fetch.ts` carries the measurements.
  // `stepFetchOrFail` makes the three-way retry decision: a 401 or a 400 answers the
  // same way on the fourth attempt and burns the step, a 429 or a 5xx is what
  // retries are for, and a `Retry-After` the provider named is waited out rather
  // than replaced by the DevKit's one-second default — which matters here more
  // than usual, because a fan-out of segments hits a rate limit together. The
  // DELETE below stays on plain `stepFetch`, because there a 404 is a SUCCESS.
  return await stepFetchOrFail(url, {
    headers: { authorization: requireStepEnv(API_KEY_ENV), "content-type": "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}
