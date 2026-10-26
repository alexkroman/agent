// Copyright 2026 the AAI authors. MIT license.
/**
 * One phone call, start to finish — the declaration, and the durable half:
 * dial, follow it, collect what was said, write it up, and tell whoever asked.
 *
 * Every call the API places is ONE run of this body, keyed by the call id, so
 * `GET /api/v1/calls/:id` is a read of the run and the finished
 * {@link CallRecord} is the run's output. Nothing else stores a call.
 *
 * ## The shape of a call, as waits
 *
 * 1. **`dial`** — `stepPlaceCall` asks Twilio to ring the number and, once it is
 *    answered, stream the audio to this agent's `WS /phone`, carrying the
 *    signed brief. Two attempts at most: Twilio takes no idempotency key, so a
 *    retried dial whose first answer was lost rings the phone twice.
 * 2. **`ring`** — a `ctx.poll` of the carrier's status, until the call is
 *    answered or over. Polled, because a call nobody picks up never reaches a
 *    session, so nothing else would ever say "no answer".
 * 3. **The call itself** — once it is answered the run PARKS on
 *    `ctx.waitForSignal("callEnded")` until the session's `onSessionEnd`
 *    signals the transcript (`agent.ts`, `signalRun(call, id, "callEnded")`):
 *    the token is derived from the run's own key — the call id — on both
 *    sides, so neither spells it. Suspended, not blocked: a ten-minute call
 *    costs nothing while it runs. The window is the call's own time limit plus
 *    slack, and closing unanswered is an outcome, not a failure.
 * 4. **`summarize`** and **`webhook`** — one model call over the transcript,
 *    then one POST of the finished record to the caller's `webhook_url`.
 *
 * ## A dial the carrier REFUSES is a result, not a failed run
 *
 * A wrong number, a caller id not on the account, a trial account calling an
 * unverified phone — `PlaceCallError` says which, in a sentence, with
 * `retryable: false`. The run catches exactly that case and completes with
 * `outcome: "failed"` and the sentence as `error`, so the API caller and the
 * webhook get the reason rather than a run that died. A retryable refusal (a
 * 429, a 5xx) is still thrown, so the engine's retry gets its turn.
 */

import { MAX_CALL_BRIEF_PROMPT_CHARS, type WorkflowContext, workflow } from "@alexkroman1/aai";
import {
  isCallOver,
  PlaceCallError,
  type PlacedCallStatus,
  requireStepEnv,
  stepCallStatus,
  stepFetch,
  stepGenerateJson,
  stepPlaceCall,
} from "@alexkroman1/aai/step";
import { orFail } from "@alexkroman1/aai/step-errors";
import { errorMessage, omitUndefined } from "@alexkroman1/aai/utils";
import { z } from "zod";
import type { CallOutcome, CallRecord, TranscriptTurn } from "../api-types.ts";

/** An E.164 number: a `+`, a country code, and up to fifteen digits in all. */
const E164 = /^\+[1-9]\d{6,14}$/;

/**
 * What `POST /api/v1/calls` accepts. Field names are snake_case because they
 * are the public API's, exactly as the curl example writes them.
 */
export const callRequest = z.object({
  phone_number: z.string().regex(E164, "phone_number must be E.164, like +14155550132"),
  prompt: z
    .string()
    .trim()
    .min(1, "prompt is required")
    .max(
      MAX_CALL_BRIEF_PROMPT_CHARS,
      `prompt is at most ${MAX_CALL_BRIEF_PROMPT_CHARS} characters`,
    ),
  webhook_url: z.url({ protocol: /^https?$/ }).optional(),
});

const callInput = callRequest.extend({
  id: z.string().describe("This app's call id — the run is keyed by it"),
  created_at: z.number().describe("Epoch ms the call was requested"),
});

/** What the API hands the run. */
export type CallInput = z.infer<typeof callInput>;

/** What the answering session signals as it ends. */
export type CallEnded = {
  transcript: TranscriptTurn[];
  duration_seconds: number;
  /** Whether the session reached an answering machine — `end_call` said so. */
  voicemail: boolean;
};

/** The longest a call may last, in seconds — Twilio hangs up at this. */
export const CALL_TIME_LIMIT_S = 600;

/** How often the run asks whether the phone has been answered. */
export const RING_POLL_MS = 5000;

/**
 * How long the run rings before it gives up on an answer — past Twilio's own
 * 30-second ring timeout, so the carrier normally says `no-answer` first.
 */
export const RING_BUDGET_MS = 60_000;

/**
 * How long the run waits for the session to hand over its transcript: the
 * call's whole time limit, plus slack for the session to wind down.
 */
export const CALL_WINDOW_MS = (CALL_TIME_LIMIT_S + 120) * 1000;

/** A dial the carrier accepted, or the sentence it refused with. */
export type Dialled = { callId: string } | { refused: string };

/**
 * Ask Twilio to ring `phone_number` and stream the answered call to this
 * agent — `stepPlaceCall` points it at the agent's own public URL and signs
 * the brief with `CALLS_API_KEY`, which the answering session verifies. A
 * refusal nobody can retry past — a missing env key, a bad number, no public
 * URL — comes back as `{ refused }`; anything retryable is thrown.
 */
export async function dial(input: CallInput): Promise<Dialled> {
  try {
    const { callId } = await stepPlaceCall({
      carrier: "twilio",
      to: input.phone_number,
      from: requireStepEnv("TWILIO_FROM_NUMBER"),
      brief: { id: input.id, prompt: input.prompt },
      timeLimitS: CALL_TIME_LIMIT_S,
    });
    return { callId };
  } catch (err: unknown) {
    if (err instanceof PlaceCallError && err.retryable) throw err;
    return { refused: errorMessage(err) };
  }
}

/** Where the carrier says the call is. */
export async function readStatus(callId: string): Promise<PlacedCallStatus> {
  return await stepCallStatus({ carrier: "twilio", callId });
}

/** Answered (or answered and already over) — the run should wait for the transcript. */
function connected(status: PlacedCallStatus): boolean {
  return status === "in-progress" || status === "completed";
}

/** The carrier's word for a call that never reached a session. */
function unansweredOutcome(status: PlacedCallStatus): CallOutcome {
  switch (status) {
    // Spelled per case: `PlacedCallStatus` is OPEN (a carrier may report a status
    // this SDK has not named yet), so a matched case does not narrow `status`.
    case "busy":
      return "busy";
    case "failed":
      return "failed";
    case "canceled":
      return "canceled";
    default:
      // Still `queued`/`ringing` after every poll reads as nobody picking up.
      return "no-answer";
  }
}

const Summary = z.object({
  summary: z
    .string()
    .describe("Two or three sentences: what happened on the call and anything agreed"),
});

/** The transcript as plain lines, which is what a model reads best. */
export function transcriptText(transcript: readonly TranscriptTurn[]): string {
  return transcript
    .map((turn) => `${turn.role === "agent" ? "Agent" : "Callee"}: ${turn.text}`)
    .join("\n");
}

/**
 * Write the call up in two or three sentences, against the task it was given.
 * Whether it reached a person or a machine is not asked here: the session
 * knew, and said so on the signal (`CallEnded.voicemail`).
 */
export async function summarize(
  prompt: string,
  transcript: readonly TranscriptTurn[],
): Promise<z.infer<typeof Summary>> {
  return await orFail(stepGenerateJson)(
    `The task the caller was given:\n${prompt}\n\nThe call:\n${transcriptText(transcript)}`,
    {
      schema: Summary,
      system:
        "You write up phone calls an AI agent placed. Say plainly what the person on the line said and decided, " +
        "and anything they asked for. Never invent details the call does not contain.",
    },
  );
}

/** POST the finished record to the caller's webhook. A non-2xx is retried by the engine. */
export async function deliver(webhookUrl: string, record: CallRecord): Promise<number> {
  const response = await orFail(stepFetch)(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(record),
  });
  return response.status;
}

/** The record the run returns, before the webhook has had its say. */
function callRecord(
  input: CallInput,
  outcome: CallOutcome,
  fields: {
    transcript?: TranscriptTurn[];
    duration_seconds?: number;
    summary?: string;
    error?: string;
  },
): CallRecord {
  return {
    id: input.id,
    status: "completed",
    phone_number: input.phone_number,
    created_at: input.created_at,
    outcome,
    transcript: fields.transcript ?? [],
    ...omitUndefined({
      duration_seconds: fields.duration_seconds,
      summary: fields.summary,
      error: fields.error,
    }),
  };
}

/** The body — see this module's doc for the four stages. */
export async function callFlow(input: CallInput, ctx: WorkflowContext): Promise<CallRecord> {
  const dialled = await ctx.step("dial", () => dial(input), { maxAttempts: 2 });
  if ("refused" in dialled) {
    return await finish(input, callRecord(input, "failed", { error: dialled.refused }), ctx);
  }

  const rang = await ctx.poll("ring", () => readStatus(dialled.callId), {
    everyMs: RING_POLL_MS,
    maxMs: RING_BUDGET_MS,
    done: (status) => connected(status) || isCallOver(status),
  });
  if (!connected(rang.value)) {
    return await finish(input, callRecord(input, unansweredOutcome(rang.value), {}), ctx);
  }

  // The token is `<workflow>:<key>:callEnded` — the run's key is the call id
  // (`api.ts` starts it so), and `onSessionEnd` answers with `signalRun`.
  const ended = await ctx.waitForSignal<CallEnded>("callEnded", { timeoutMs: CALL_WINDOW_MS });
  if (ended === undefined) {
    return await finish(
      input,
      callRecord(input, "answered", {
        error: "The call was answered, but its transcript never reached this run.",
      }),
      ctx,
    );
  }

  const written =
    ended.transcript.length === 0
      ? undefined
      : await ctx.step("summarize", () => summarize(input.prompt, ended.transcript));
  return await finish(
    input,
    callRecord(input, ended.voicemail ? "voicemail" : "answered", {
      transcript: ended.transcript,
      duration_seconds: ended.duration_seconds,
      ...omitUndefined({ summary: written?.summary }),
    }),
    ctx,
  );
}

/**
 * Deliver the record to the webhook, when one was given, and return it.
 *
 * A webhook that keeps failing does not fail the CALL — the call happened, and
 * the record is still readable from the API — so its failure is written onto
 * the record as `error` instead.
 */
async function finish(
  input: CallInput,
  record: CallRecord,
  ctx: WorkflowContext,
): Promise<CallRecord> {
  const url = input.webhook_url;
  if (url === undefined) return record;
  try {
    await ctx.step("webhook", () => deliver(url, record), { maxAttempts: 3 });
    return record;
  } catch (err: unknown) {
    return {
      ...record,
      error: record.error ?? `The webhook was not delivered: ${errorMessage(err)}`,
    };
  }
}

/** The declaration, registered as `call` by this file's name. */
export default workflow({
  description: "Place one phone call, follow it to the end, and write up what was said",
  input: callInput,
  run: callFlow,
  // The one line `GET /v1/calls/:id` says about a call that is not over.
  describeRun: (run) => {
    const who = run.label ?? "the call";
    switch (run.status) {
      case "completed":
        return `${who}: ${run.output.outcome}${run.output.summary === undefined ? "" : ` — ${run.output.summary}`}`;
      case "failed":
        return `${who} failed: ${run.error}`;
      case "cancelled":
        return `${who} was cancelled.`;
      default:
        return `${who}: dialled, waiting for the call to end.`;
    }
  },
  cancelNote: "Cancelling the run does not hang up a call already in progress.",
});
