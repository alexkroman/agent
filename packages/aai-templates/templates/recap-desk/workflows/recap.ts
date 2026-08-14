// Copyright 2026 the AAI authors. MIT license.
/**
 * The durable half of the recap desk — and the file the Temporal patterns were
 * ported into.
 *
 * Read `research-desk/workflows/research.ts` first for the two rules every
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
 *
 * The voice half — start, query, cancel — is ported in `agent.ts`.
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
 * `stepGenerate`. The BATCH API is what makes the polling port honest: it
 * answers with a job id in milliseconds and finishes minutes later, so the wait
 * is the provider's, not a `setTimeout` this template chose. (Its sibling
 * `transcription-desk` takes the other endpoint — the sync one, which answers in
 * the request and pays for it with a hard cap, so its shape is a fan-out rather
 * than a poll.)
 *
 * A step is handed no `ToolContext`, so the key comes from `requireStepEnv`
 * rather than `ctx.env`; under `aai dev` that means it has to be in `.env`, not
 * just your shell.
 */

import {
  errorMessage,
  isTransientStatus,
  omitUndefined,
  report,
  requireStepEnv,
  retryAfter,
  StepGenerateError,
  safeJsonParse,
  stepGenerate,
} from "@alexkroman1/aai/utils";
import { FatalError, RetryableError, sleep } from "workflow";

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
    return { ...recap, requestedBy: input.requestedBy };
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
 * from a helper is still a real step (`mapInBatches` rests on the same
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

  const response = await request(TRANSCRIPT_ENDPOINT, {
    method: "POST",
    body: JSON.stringify({ audio_url: url, speaker_labels: true }),
  });
  const body = await response.json();
  const id = readString(body, "id");
  if (!id) throw new Error("The provider accepted the recording but named no transcript id.");
  return { id };
}

/**
 * Read the job's status once.
 *
 * One poll is one step, so each attempt is journaled on its own: a run that dies
 * mid-wait resumes knowing what the last answer was instead of starting the
 * recording over.
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
  const response = await fetch(`${TRANSCRIPT_ENDPOINT}/${id}`, {
    method: "DELETE",
    headers: { authorization: requireStepEnv(API_KEY_ENV) },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status === 404) return;
  if (!response.ok) throw requestFailure(response, `DELETE ${TRANSCRIPT_ENDPOINT}/${id}`);
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

  const reply = await stepGenerate(text, {
    system:
      "You write up recordings for someone who will hear the result on a phone call. " +
      `Reply with JSON only: {"headline": string, "points": string[], "spoken": string}. ` +
      `Give exactly ${POINTS} points. "spoken" is ONE sentence, under 30 words, ` +
      "written to be read aloud. No markdown fence, no preamble.",
  }).catch(stopOrRetry);

  const parsed = safeJsonParse(stripFence(reply));
  if (!isRecapShape(parsed)) {
    // A PLAIN throw, unlike the fatal one above: a model that answered in prose
    // may well answer in JSON on the next attempt.
    throw new Error("The model did not return the JSON shape this step asked for.");
  }
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
async function request(url: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(url, {
    ...init,
    headers: { authorization: requireStepEnv(API_KEY_ENV), "content-type": "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw requestFailure(response, `${init.method ?? "GET"} ${url}`);
  return response;
}

/**
 * The retryable/terminal split for a provider call.
 *
 * A 401 or a 400 answers the same way on the fourth attempt, so it burns the
 * step rather than the account's rate limit; a 429 or a 5xx is exactly what
 * retries are for, and `RetryableError` is what carries the provider's own
 * `Retry-After` into the DevKit's schedule instead of leaving it on the default
 * backoff.
 */
function requestFailure(response: Response, label: string): Error {
  const message = `${label} failed: HTTP ${response.status}`;
  if (!isTransientStatus(response.status)) return new FatalError(message);
  const at = retryAfter(response);
  return at ? new RetryableError(message, { retryAfter: at }) : new RetryableError(message);
}

/**
 * Turn a terminal gateway failure into one the DevKit will not retry.
 *
 * A plain function rather than a `throw` inside a `catch`: `FatalError` takes
 * only a message — no `cause` — so constructing one in a catch block loses the
 * original where the linter (rightly) expects it preserved. `link-digest` and
 * `research-desk` carry the same three lines for the same reason.
 */
function stopOrRetry(err: unknown): never {
  if (err instanceof StepGenerateError && !err.retryable) throw new FatalError(err.message);
  throw err;
}

/** Unwrap a ```json fence, which models add however firmly they are told not to. */
export function stripFence(reply: string): string {
  const fenced = /^\s*```(?:json)?\s*\n([\s\S]*?)\n?\s*```\s*$/.exec(reply);
  return (fenced?.[1] ?? reply).trim();
}

/** Is this the shape `summarize` promised its caller? */
export function isRecapShape(
  value: unknown,
): value is { headline: string; points: string[]; spoken: string } {
  if (value === null || typeof value !== "object") return false;
  const shape = value as { headline?: unknown; points?: unknown; spoken?: unknown };
  return (
    typeof shape.headline === "string" &&
    shape.headline.trim() !== "" &&
    typeof shape.spoken === "string" &&
    shape.spoken.trim() !== "" &&
    Array.isArray(shape.points) &&
    shape.points.length > 0 &&
    shape.points.every((point) => typeof point === "string")
  );
}

/** A string field of a JSON body, when it really is one. */
function readString(body: unknown, key: string): string | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

/** A number field of a JSON body, when it really is one. */
function readNumber(body: unknown, key: string): number | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
