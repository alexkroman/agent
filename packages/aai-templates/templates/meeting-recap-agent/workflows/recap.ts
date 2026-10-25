// Copyright 2026 the AAI authors. MIT license.
/**
 * The durable half of the recap desk — the declaration, and the file the
 * Temporal patterns were ported into.
 *
 * Read `research-handoff-agent/workflows/research.ts` first for the handoff
 * shape. What THIS template adds is the three shapes a durable engine exists
 * for, ported from the Temporal TypeScript samples and running against a real
 * provider rather than a stub:
 *
 * | Temporal sample | Ported here as |
 * | --- | --- |
 * | `saga` — `openAccount`'s compensation stack | {@link recapFlow}'s `compensations`, unwound by {@link compensate} |
 * | `polling` — infrequent polling | {@link awaitTranscript}: one `ctx.poll`, each check a step and each wait a durable sleep |
 * | `timer-examples` — `processOrderWorkflow` | the poll's `slowAfterMs`: the "still going" note, once, two minutes in |
 * | `expense` — `timeoutOrUserAction` | the RETENTION GATE: one `ctx.waitFor` with {@link RETENTION_WINDOW_MS}, three outcomes and a safe default |
 *
 * The voice half — start, query, cancel, and the answer to the gate — is
 * `agent.ts` and `tools/`.
 *
 * ## The provider CALLS BACK, and the poll is what makes that safe
 *
 * AssemblyAI's async API takes a `webhook_url` on submission, so the ordinary
 * case needs one status read instead of nine: {@link submitRecording} hands over
 * the URL `stepWebhookUrl` mints (or none, where the deployment has no public
 * URL), and the poll parks on that token FIRST, for {@link CALLBACK_WINDOW_MS}.
 * The run is SUSPENDED throughout, so this is not a saving on process time;
 * what it buys is a recap that starts being written the second the transcript
 * exists.
 *
 * **The poll did not go away, and it must not.** A webhook is one HTTP POST
 * with no delivery guarantee anyone here controls, so the callback is an
 * OPTIMIZATION OVER A RECONCILING READ: whether or not the delivery lands, the
 * run reads the status under its own credential, and a forged delivery on a
 * guessed token costs one extra read and changes no decision. That is what
 * makes the unauthenticated callback route safe here, and why this template
 * sets none of the provider's webhook auth headers — the route authorizes on
 * the TOKEN and reads no other header.
 *
 * ## Why these are worth porting rather than restating
 *
 * **A `try`/`finally` in a tool body is not a transaction.** The process holding
 * it can die, and everything it was going to clean up is then nobody's. Here
 * every one of those moves is a journaled step: the compensation stack is
 * unwound by CODE THAT IS ITSELF DURABLE (a crash mid-unwind resumes with the
 * finished undos replayed and re-issues only what is left), the poll's waits
 * suspend the run so the sandbox is free between attempts, and the "still
 * going" note is journaled so a replay says it once.
 *
 * ## What is real here
 *
 * `submitRecording`, `checkTranscript` and `discardTranscript` are AssemblyAI's
 * pre-recorded API (`POST`, `GET` and `DELETE` on `/v2/transcript`), and
 * `summarize` is a real model call. The BATCH API is what makes the polling
 * port honest: it answers with a job id in milliseconds and finishes minutes
 * later. A step reads the key with `requireStepEnv`, so under `aai dev` it has
 * to be in `.env`.
 */

import { type WorkflowContext, workflow } from "@alexkroman1/aai";
import {
  requireStepEnv,
  type StepFetchInit,
  stepFetch,
  stepGenerateJson,
  stepReport,
  stepTranscribeSubmit,
  stepWebhookUrl,
} from "@alexkroman1/aai/step";
import { FatalError, orFail, toStepError } from "@alexkroman1/aai/step-errors";
import { errorMessage, omitUndefined } from "@alexkroman1/aai/utils";
import { isTerminal } from "@alexkroman1/aai/workflow-api";
import { z } from "zod";
import { retentionToken, transcriptToken } from "./tokens.ts";

/**
 * What the desk works on when the caller does not name something else.
 *
 * A phone caller cannot read a URL aloud, so the template transcribes the
 * provider's public sample on the first call. A real desk replaces this with a
 * lookup against its own recording store.
 */
export const SAMPLE_RECORDING = "https://assembly.ai/wildfires.mp3";

/** AssemblyAI's pre-recorded (batch) transcription collection. */
const TRANSCRIPT_ENDPOINT = "https://api.assemblyai.com/v2/transcript";

/** The key a step reads out of the agent env. Declared in `agent.ts`'s `requiredEnv`. */
const API_KEY_ENV = "ASSEMBLYAI_API_KEY";

/**
 * How long the run waits between polls. A durable sleep, so the wait costs
 * nothing: fifteen seconds is responsive for a meeting-length file.
 */
const POLL_INTERVAL_MS = 15_000;

/** The polling budget — far past the turnaround of any recording a caller will name. */
const POLL_BUDGET_MS = 20 * 60_000;

/** How long the desk polls before it admits a recording is a long one. */
const PATIENCE_MS = 120_000;

/**
 * How long one park on the provider's callback lasts. Two minutes rather than
 * the twenty the poll budgets: the window is what a DROPPED delivery costs, and
 * nothing is lost when it closes — the run simply goes back to reading.
 */
const CALLBACK_WINDOW_MS = 120_000;

/**
 * How long the desk holds the transcript waiting for an answer.
 *
 * The port of `timeoutOrUserAction`: three outcomes — approved, declined,
 * nobody answered — with the window journaled once so a replay cannot extend
 * it. Two minutes because a caller is on the line; a desk whose approver is on
 * email would write two days and nothing else would change.
 */
const RETENTION_WINDOW_MS = 120_000;

/** Every HTTP call's deadline. `fetch` has none of its own, and a hung step never ends. */
const REQUEST_TIMEOUT_MS = 30_000;

/** Transcript characters handed to the model — capped because the payload crosses the queue. */
const MAX_TRANSCRIPT_CHARS = 24_000;

/** Points a recap is reduced to. */
const POINTS = 3;

/**
 * The shape the model must answer in. `orFail(stepGenerateJson)` validates
 * against it and throws PLAINLY when the reply misses, so a model that answered
 * in prose is retried where a 401 is not. `spoken` is the field this template
 * exists for — the announced turn reads it down the phone — so it is required.
 */
const RecapReply = z.object({
  headline: z.string().min(1).describe("One line, for an eye"),
  points: z
    .array(z.string())
    .min(1)
    .describe(`Exactly ${POINTS} points`)
    .transform((points) => points.slice(0, POINTS)),
  spoken: z.string().min(1).describe("ONE sentence, under 30 words, written to be read aloud"),
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
 * The poll response, as much of it as this desk reads.
 *
 * The three optional fields DEGRADE and the status does not: a field of the
 * wrong type is `undefined` (`.catch`), because the job is still one this desk
 * can act on, while a status outside the four is refused — nothing downstream
 * knows what to do with it, and polling to the bound would fail with the wrong
 * reason. `z.number()` refuses `NaN` and the infinities, which is what keeps a
 * non-finite duration out of `Math.round(… / 60)` in {@link summarize}.
 */
const TranscriptBody = z.object({
  status: z.enum(["queued", "processing", "completed", "error"]),
  text: z.string().optional().catch(undefined),
  error: z.string().optional().catch(undefined),
  audio_duration: z.number().optional().catch(undefined),
});

/** The status to NAME when {@link TranscriptBody} refused the body, never throwing a second time. */
const ReportedStatus = z
  .object({ status: z.string().optional() })
  .catch({})
  .transform((body) => body.status);

/**
 * One undo, and the name it goes by when it fails.
 *
 * Ported field-for-field from Temporal's `saga` sample. The label is not
 * decoration: a compensation that fails is SWALLOWED (see {@link compensate}),
 * so the label is the only thing that says what was left behind.
 */
export type Compensation = { label: string; undo: () => Promise<void> };

/**
 * Transcribe a recording, write it up, and leave nothing behind if it fails.
 *
 * Whatever this returns is what a completed run reports as `output` — which
 * the status line reads back down the phone, so it is shaped for an ear.
 */
export async function recapFlow(input: { url: string; requestedBy: string }, ctx: WorkflowContext) {
  // The compensation stack, newest first — `unshift` after each successful
  // acquisition, exactly as Temporal's `openAccount` does. Registering the undo
  // AFTER the step it undoes is the whole discipline: a step that never
  // succeeded has nothing to reverse.
  const compensations: Compensation[] = [];

  try {
    // The token the callback URL is minted for and the poll parks on: derived
    // from the run's own input in one place (`tokens.ts`), because the two
    // sides are separated by a third party on the public internet.
    const nudge = transcriptToken(input.requestedBy);
    // Minted INSIDE the step, so it runs once and never on a replay.
    const transcriptId = await ctx.step("submitRecording", () =>
      submitRecording(input.url, stepWebhookUrl(nudge, { optional: true })),
    );
    compensations.unshift({
      label: `transcript ${transcriptId}`,
      undo: () => ctx.step("discardTranscript", () => discardTranscript(transcriptId)),
    });

    const transcript = await awaitTranscript(transcriptId, nudge, ctx);

    const recap = await ctx.step("summarize", () => summarize(input.url, transcript), {
      // A rate limit's own `Retry-After` is a WAIT, not one of the three
      // attempts a reply that missed the shape is allowed.
      maxWaits: 3,
    });
    const retention = await askWhetherToKeep(input.requestedBy, transcriptId, compensations, ctx);
    return { ...recap, ...retention, requestedBy: input.requestedBy };
  } catch (err) {
    // The saga's whole point. Everything acquired above is released, in
    // reverse, before the failure is re-thrown — and because each undo is a
    // STEP, a crash during the unwind resumes with the finished ones replayed
    // from the journal rather than run twice. Only a step failure lands here:
    // a wait hands back a promise that never settles, so a parked body does
    // not reach a `catch` at all.
    await compensate(compensations, errorMessage(err), ctx);
    throw err;
  }
}

/**
 * Poll one transcript job until it settles — the `polling` port, with the
 * callback over it.
 *
 * `ctx.poll` parks on the callback token ONCE before the first read, then reads
 * on the cadence: a delivery that lands wakes it, a dropped one costs the
 * window and nothing else. The payload is never read — the status comes from
 * the provider's own endpoint under this desk's credential, which is the
 * security argument in the module doc.
 */
export async function awaitTranscript(
  id: string,
  nudge: string,
  ctx: WorkflowContext,
): Promise<TranscriptState> {
  const polled = await ctx.poll("checkTranscript", () => checkTranscript(id), {
    everyMs: POLL_INTERVAL_MS,
    maxMs: POLL_BUDGET_MS,
    done: (state) => state.status === "completed" || state.status === "error",
    first: { waitFor: nudge, timeoutMs: CALLBACK_WINDOW_MS },
    slowAfterMs: PATIENCE_MS,
    onSlow: "Still transcribing — this is a long one. I'll keep going.",
  });
  if (polled.value.status === "error") {
    // The provider's own terminal answer. A plain `Error`, not a `FatalError`:
    // this is the BODY, whose throw is never retried.
    throw new Error(`The provider could not transcribe that recording: ${polled.value.error}`);
  }
  if (!polled.done) throw new Error(`Gave up on that recording after ${polled.checks} checks.`);
  return polled.value;
}

/**
 * Ask the caller whether the transcript stays on file, and act on the answer.
 *
 * The port of Temporal's `timeoutOrUserAction`. The default is DELETE, which is
 * what makes the timeout meaningful: a gate whose no-answer branch keeps the
 * data is a prompt with a grace period, and for a desk holding transcripts of
 * other people's meetings the safe default is the one that leaves nothing
 * behind.
 */
export async function askWhetherToKeep(
  requestedBy: string,
  transcriptId: string,
  compensations: Compensation[],
  ctx: WorkflowContext,
): Promise<Retention> {
  await ctx.report(
    "noteGate",
    "Recap ready. Keep the transcript on file, or delete it? Deleting in two minutes otherwise.",
  );

  // ONE call, not a race: the deadline is journaled with the hook, and the
  // timeout arm CLOSES it before the body continues, so a late answer cannot
  // change a window that already timed out.
  const answer = await ctx.waitFor<{ keep: boolean }>(retentionToken(requestedBy), {
    timeoutMs: RETENTION_WINDOW_MS,
  });

  if (answer?.keep === true) return { kept: true, answered: true };
  await ctx.step("discardOnDecline", () => discardTranscript(transcriptId));
  // Drop the undo now that the run has DONE what it undoes: an unwind that
  // reverses something already gone would narrate a story that did not happen.
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
 * reported and stepped over rather than thrown.
 */
export async function compensate(
  compensations: Compensation[],
  because: string,
  ctx: WorkflowContext,
): Promise<void> {
  if (compensations.length === 0) return;
  // `ctx.report` journals the line, so an unwind interrupted by a crash resumes
  // with the lines already said replayed rather than said twice.
  await ctx.report(
    "noteUnwind",
    `Recap failed (${because}) — undoing ${compensations.length} step(s).`,
  );
  for (const compensation of compensations) {
    try {
      await compensation.undo();
    } catch (err) {
      await ctx.report(
        "noteUndoFailed",
        `Could not undo ${compensation.label}: ${errorMessage(err)}`,
      );
    }
  }
}

// ---- Steps ------------------------------------------------------------------

/**
 * Hand the recording to the provider; answers the job id.
 *
 * `webhookUrl` is where the provider should POST when the job settles, or
 * `undefined` where this deployment cannot mint one. It rides the same `params`
 * passthrough as `speaker_labels`, and an absent one is an absent KEY on the
 * wire — never a `?? null`, which a provider handed a null for a URL is entitled
 * to refuse.
 */
export async function submitRecording(url: string, webhookUrl?: string): Promise<string> {
  await stepReport(`Submitting ${new URL(url).hostname} for transcription…`);
  const job = await orFail(stepTranscribeSubmit)(url, {
    params: { speaker_labels: true, webhook_url: webhookUrl },
  });
  return job.id;
}

/**
 * Read the job's status once.
 *
 * Deliberately NOT `stepTranscribePoll`, which answers `done` and THROWS on a
 * job the provider gave up on. This desk's question is different: `status` is
 * a VALUE here, and an `error` status is the branch that unwinds the saga's
 * compensation stack rather than a failure to propagate.
 */
export async function checkTranscript(id: string): Promise<TranscriptState> {
  const response = await request(`${TRANSCRIPT_ENDPOINT}/${id}`);
  const body = await response.json();
  const parsed = TranscriptBody.safeParse(body);
  if (!parsed.success) {
    throw new Error(
      `The provider reported an unknown transcript status: ${String(ReportedStatus.parse(body))}`,
    );
  }

  await stepReport(`Transcript ${parsed.data.status}.`);
  return {
    status: parsed.data.status,
    // A field `.catch`-ed to `undefined` is PRESENT in zod's output, and this
    // result crosses a queue where such a key does not survive the trip.
    ...omitUndefined({
      text: parsed.data.text,
      error: parsed.data.error,
      audioDuration: parsed.data.audio_duration,
    }),
  };
}

/**
 * Delete the transcript this run created — the compensation, and a real one.
 *
 * A `404` is SUCCESS here, which is the property every compensation needs: the
 * undo has to be safe to run against a world where it already happened, because
 * a replay is exactly that world.
 */
export async function discardTranscript(id: string): Promise<void> {
  await stepReport(`Discarding transcript ${id}.`);
  // Raw `stepFetch` rather than `orFail(stepFetch)`, because a 404 is a success.
  const response = await stepFetch(`${TRANSCRIPT_ENDPOINT}/${id}`, apiInit({ method: "DELETE" }));
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
 * Its own step, so a rate-limited model call replays the whole transcription —
 * twenty minutes of provider time, already paid for — out of the journal
 * instead of submitting the recording again.
 */
export async function summarize(url: string, transcript: TranscriptState): Promise<Recap> {
  await stepReport("Writing the recap.");

  const text = (transcript.text ?? "").slice(0, MAX_TRANSCRIPT_CHARS);
  if (text.trim() === "") {
    // Not transient: the same completed transcript holds the same nothing on
    // every attempt. Silence, or an audio file with no speech in it.
    throw new FatalError("That recording came back with no speech in it.");
  }

  const parsed = await orFail(stepGenerateJson)(text, {
    schema: RecapReply,
    system: "You write up recordings for someone who will hear the result on a phone call.",
  });

  return {
    url,
    headline: parsed.headline,
    points: parsed.points,
    spoken: parsed.spoken,
    minutes: Math.round((transcript.audioDuration ?? 0) / 60),
  };
}

// ---- HTTP -------------------------------------------------------------------

/**
 * The credential and the deadline every call to the pre-recorded API carries.
 * A bare key — AssemblyAI's `authorization` takes no `Bearer` prefix — read
 * HERE rather than at module scope, because `requireStepEnv` must run inside
 * the step that needs it. Spreading `extra` first lets a caller add a method
 * or a content type and never quietly drop the credential.
 */
function apiInit(extra: StepFetchInit = {}): StepFetchInit {
  return {
    ...extra,
    headers: { authorization: requireStepEnv(API_KEY_ENV), ...extra.headers },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  };
}

/** One authenticated request to the pre-recorded API, with this desk's retry policy on it. */
async function request(url: string): Promise<Response> {
  // `orFail(stepFetch)` makes the three-way retry decision: a 401 burns the
  // step, a 429 or a 5xx retries, and a `Retry-After` the provider named is
  // waited out rather than replaced by the engine's default.
  return await orFail(stepFetch)(url, apiInit({ headers: { "content-type": "application/json" } }));
}

// ---- The declaration --------------------------------------------------------

/**
 * The workflow, registered as `recap` by this file's name. `describeRun` and
 * `cancelNote` are what the `workflow_status` and `workflow_cancel` builtins
 * say about a run — the QUERY and the CANCELLATION ports, in the desk's words.
 */
export default workflow({
  description:
    "Transcribe a recording with the batch API, poll it to completion, and write up what was said",
  input: z.object({
    url: z.url().describe("The recording to write up"),
    requestedBy: z.string().describe("Who asked — carried through to the finished recap"),
  }),
  run: recapFlow,
  describeRun: (run) => {
    if (!isTerminal(run)) return "Still working on that one.";
    switch (run.status) {
      case "completed": {
        // The gate's outcome is part of the answer: a caller who never got
        // round to answering should hear that the transcript is gone.
        const fate = run.output.kept ? "transcript kept" : "transcript deleted";
        return `Done: ${run.output.spoken} (${fate})`;
      }
      case "failed":
        // The run compensated before it failed, so there is nothing left to
        // clean up and nothing for the caller to do beyond asking again.
        return `That one failed and was rolled back: ${run.error}`;
      default:
        return "That one was cancelled.";
    }
  },
  // Said plainly because it is true: cancellation is NOT cooperative on this
  // engine — `ctx.workflows.cancel` stops replay, so the saga's `catch` never
  // runs and the transcript the run had already created stays on the account.
  cancelNote: "Stopped it. The partial transcript is left behind — cancelling does not roll back.",
});
