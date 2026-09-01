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
 * | `polling` — infrequent polling | {@link awaitTranscript}: a bounded loop of one step plus one durable `sleep` |
 * | `timer-examples` — `processOrderWorkflow` | the `Promise.race` against {@link PATIENCE}, then the "still going" note |
 * | `expense` — `timeoutOrUserAction` | the RETENTION GATE: a hook raced against {@link RETENTION_WINDOW}, three outcomes and a safe default |
 *
 * The voice half — start, query, cancel, and the answer to the gate — is ported
 * in `agent.ts`.
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
 * `stepGenerateJsonClassified`. The BATCH API is what makes the polling port honest: it
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

import { report, requireStepEnv, stepFetch } from "@alexkroman1/aai/step";
import {
  FatalError,
  stepFetchOk,
  stepGenerateJsonClassified,
  stepTranscribeSubmitClassified,
  toStepError,
} from "@alexkroman1/aai/step-errors";
import { errorMessage, isRecord, omitUndefined } from "@alexkroman1/aai/utils";
import { createHook, sleep } from "workflow";
import { z } from "zod";
import { retentionToken } from "./tokens.ts";

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
const POLL_INTERVAL = "15 seconds";

/**
 * Polls before the desk gives up.
 *
 * A bound rather than a deadline, because it is what the LOOP can enforce with
 * nothing but journaled values: attempt N is attempt N on every replay, where a
 * wall-clock deadline read in the body would move under it. At
 * {@link POLL_INTERVAL} this is twenty minutes, which is far past the
 * turnaround of any recording a phone caller will name.
 */
const MAX_POLLS = 80;

/**
 * How long the desk waits before admitting a recording is a long one.
 *
 * The port of Temporal's `processOrderWorkflow`: race the work against a timer,
 * and if the timer wins, do the other thing — there the delayed-order email,
 * here a progress line the caller hears when they ask. Then keep waiting for
 * the work either way.
 */
const PATIENCE = "2 minutes";

/**
 * How long the desk holds the transcript waiting for an answer.
 *
 * The port of `timeoutOrUserAction`: Temporal races a `condition()` against a
 * timeout, this races a hook against a `sleep`, and both have THREE outcomes —
 * approved, declined, nobody answered. The window is a `sleep`, so a caller who
 * hangs up costs nothing while it runs.
 *
 * Two minutes because a caller is on the line; a desk whose approver is on email
 * would write `"2 days"` and nothing else in this file would change.
 */
const RETENTION_WINDOW = "2 minutes";

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
 * `stepGenerateJsonClassified` validates against this and throws PLAINLY when the reply
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
export async function recapFlow(input: { url: string; requestedBy: string }) {
  "use workflow";

  // The compensation stack, newest first — `unshift` after each successful
  // acquisition, exactly as Temporal's `openAccount` does. Registering the undo
  // AFTER the step it undoes is the whole discipline: a step that never
  // succeeded has nothing to reverse, and an undo registered before it would
  // reverse a transcript id that does not exist.
  const compensations: Compensation[] = [];

  try {
    const job = await submitRecording(input.url);
    compensations.unshift({
      label: `transcript ${job.id}`,
      undo: () => discardTranscript(job.id),
    });

    // Temporal's `processOrderWorkflow`, line for line: start the work, race it
    // against a timer, and if the timer wins first say so and then go on
    // waiting. `ready` is an ordinary local — deterministic, because the only
    // thing that flips it is a journaled step result.
    let ready = false;
    const work = awaitTranscript(job.id).then((state) => {
      ready = true;
      return state;
    });
    await Promise.race([work, sleep(PATIENCE)]);
    if (!ready) await note("Still transcribing — this is a long one. I'll keep going.");
    const transcript = await work;

    const recap = await summarize(input.url, transcript);
    const retention = await askWhetherToKeep(input.requestedBy, job.id, compensations);
    return { ...recap, ...retention, requestedBy: input.requestedBy };
  } catch (err) {
    // The saga's whole point. Everything acquired above is released, in reverse,
    // before the failure is re-thrown — and because each undo is a STEP, a crash
    // during the unwind resumes with the finished ones replayed from the journal
    // rather than run twice.
    await compensate(compensations, errorMessage(err));
    throw err;
  }
}

/**
 * Poll one transcript job until it settles.
 *
 * A body-side helper, not a step: it `sleep`s, and a step cannot — a step runs
 * to completion in a worker, where the body is what may suspend. Splitting it
 * out keeps `recapFlow` readable and costs nothing, since the WDK transform
 * rewrites a step's DECLARATION rather than its call sites, so a step called
 * from a helper is still a real step (`mapConcurrent` rests on the same
 * property).
 *
 * The loop is deterministic despite looking like it is not: every branch turns
 * on a journaled step result, so a replay takes the same number of turns it took
 * live.
 */
export async function awaitTranscript(id: string): Promise<TranscriptState> {
  for (let attempt = 1; attempt <= MAX_POLLS; attempt++) {
    const state = await checkTranscript(id);
    if (state.status === "completed") return state;
    if (state.status === "error") {
      // The provider's own terminal answer. A plain `Error`, not a
      // `FatalError`: this is the BODY, and a body's throw is never retried —
      // `FatalError` is the vocabulary for telling the DevKit not to retry a
      // STEP, and using it here would claim a distinction that does not exist.
      throw new Error(`The provider could not transcribe that recording: ${state.error}`);
    }
    // Suspended, not blocked: nothing is resident while this waits.
    await sleep(POLL_INTERVAL);
  }
  throw new Error(`Gave up on that recording after ${MAX_POLLS} checks.`);
}

/**
 * Ask the caller whether the transcript stays on file, and act on the answer.
 *
 * The port of Temporal's `timeoutOrUserAction`, and a body-side helper for the
 * same reason {@link awaitTranscript} is: it opens a hook and `sleep`s, neither
 * of which a step can do.
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
): Promise<Retention> {
  // `using`, so the token is released when this scope exits — including the
  // timeout branch, where nothing ever arrives. A hook left registered holds
  // its token against the caller's NEXT run, which `getConflict()` below would
  // then report as a conflict.
  using decision = createHook<{ keep: boolean }>({ token: retentionToken(requestedBy) });
  // Claim the token BEFORE anyone is told to signal it. `createHook()` registers
  // nothing on its own — registration is committed when the workflow suspends —
  // so without this the caller's answer races a token no hook owns yet and is
  // answered "nobody is listening", which is indistinguishable from being late.
  await decision.getConflict();

  await note(
    `Recap ready. Keep the transcript on file, or delete it? Deleting in ${RETENTION_WINDOW} otherwise.`,
  );
  const answer = await Promise.race([decision, sleep(RETENTION_WINDOW).then(() => undefined)]);

  if (answer?.keep === true) return { kept: true, answered: true };
  await discardTranscript(transcriptId);
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
export async function compensate(compensations: Compensation[], because: string): Promise<void> {
  if (compensations.length === 0) return;
  await note(`Recap failed (${because}) — undoing ${compensations.length} step(s).`);
  for (const compensation of compensations) {
    try {
      await compensation.undo();
    } catch (err) {
      await note(`Could not undo ${compensation.label}: ${errorMessage(err)}`);
    }
  }
}

// ---- Steps ------------------------------------------------------------------

/**
 * Hand the recording to the provider.
 *
 * Returns in milliseconds with a job id — the batch API's whole shape, and what
 * makes the poll below a real wait rather than a simulated one.
 */
export async function submitRecording(url: string): Promise<{ id: string }> {
  "use step";

  await report(`Submitting ${new URL(url).hostname} for transcription…`);

  // `stepTranscribeSubmitClassified` owns the endpoint, the raw-key auth, the
  // PLURAL `speech_models` field and the failure classification — the
  // `Classified` suffix being that last part: it is `stepTranscribeSubmit` with
  // `throwStepError` already applied, so a provider refusal stays terminal and a
  // rate limit waits out the delay the provider itself named. `speaker_labels`
  // is this desk's own request, which is what `params` is for — the async API's
  // surface is large and the SDK deliberately does not mirror it.
  return await stepTranscribeSubmitClassified(url, { params: { speaker_labels: true } });
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
  "use step";

  const response = await request(`${TRANSCRIPT_ENDPOINT}/${id}`);
  const body = await response.json();
  const status = readString(body, "status");
  if (
    status !== "queued" &&
    status !== "processing" &&
    status !== "completed" &&
    status !== "error"
  )
    throw new Error(`The provider reported an unknown transcript status: ${String(status)}`);

  await report(`Transcript ${status}.`);
  return {
    status,
    // `omitUndefined` rather than a spread-ternary per field: under
    // `exactOptionalPropertyTypes` an absent field and a field set to
    // `undefined` are different types, and this is the SDK's one spelling for
    // the difference.
    ...omitUndefined({
      text: readString(body, "text"),
      error: readString(body, "error"),
      audioDuration: readNumber(body, "audio_duration"),
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
  "use step";

  await report(`Discarding transcript ${id}.`);
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
  "use step";

  await report("Writing the recap.");

  const text = (transcript.text ?? "").slice(0, MAX_TRANSCRIPT_CHARS);
  if (text.trim() === "") {
    // Not transient: the same completed transcript holds the same nothing on
    // every attempt. Silence, or an audio file with no speech in it.
    throw new FatalError("That recording came back with no speech in it.");
  }

  // `stepGenerateJsonClassified` unwraps the fence a model puts around JSON
  // however firmly it is told not to, parses it, and validates it — all four
  // things this step used to re-derive. The `Classified` half is what makes a
  // terminal gateway failure (a bad key, a rejected request) stop rather than
  // burn the remaining attempts, where a reply that missed the SHAPE throws
  // plainly and retries.
  const parsed = await stepGenerateJsonClassified(text, {
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

/** A rate limit — and a model that ignored the format — are both expected here. */
summarize.maxRetries = 5;

/**
 * Say one line into the run's progress channel.
 *
 * A step for one reason: the body REPLAYS, so a `report()` written there is
 * re-emitted on every resume. Everything the body itself wants to narrate —
 * the slow-recording note, the unwind — comes through here, and `agent.ts`'s
 * `recap_progress` is what reads it back down the phone.
 */
export async function note(line: string): Promise<void> {
  "use step";
  await report(line);
}

// ---- HTTP and parsing -------------------------------------------------------

/**
 * One authenticated request to the pre-recorded API, with this desk's retry
 * policy on it.
 *
 * Note the header is a bare key: AssemblyAI's `authorization` takes the key
 * itself, with no `Bearer` prefix.
 */
async function request(
  url: string,
  init: { method?: string; body?: string } = {},
): Promise<Response> {
  // Through `stepFetch`, not `fetch`: it pins HTTP/1.1, so several concurrent
  // runs (and this workflow POLLS, so one run is many requests) get a socket
  // each rather than N streams on one connection — and a connection failure
  // arrives as a `StepTransportError` naming its cause instead of a bare
  // `TypeError: fetch failed`, which for a template whose whole subject is
  // durability is the difference between a diagnosable resume and a mystery.
  // `sdk/step-fetch.ts` carries the measurements.
  // `stepFetchOk` makes the three-way retry decision: a 401 or a 400 answers the
  // same way on the fourth attempt and burns the step, a 429 or a 5xx is what
  // retries are for, and a `Retry-After` the provider named is waited out rather
  // than replaced by the DevKit's one-second default — which matters here more
  // than usual, because a fan-out of segments hits a rate limit together. The
  // DELETE below stays on plain `stepFetch`, because there a 404 is a SUCCESS.
  return await stepFetchOk(url, {
    ...init,
    headers: { authorization: requireStepEnv(API_KEY_ENV), "content-type": "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

/** A string field of a JSON body, when it really is one. */
function readString(body: unknown, key: string): string | undefined {
  const value = isRecord(body) ? body[key] : undefined;
  return typeof value === "string" ? value : undefined;
}

/** A number field of a JSON body, when it really is one. */
function readNumber(body: unknown, key: string): number | undefined {
  const value = isRecord(body) ? body[key] : undefined;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
