// Copyright 2026 the AAI authors. MIT license.
/**
 * The durable half of one phone call: dial, follow it, collect what was said,
 * write it up, and tell whoever asked.
 *
 * Every call the API places is ONE run of this body, keyed by the call id, so
 * `GET /api/v1/calls/:id` is a read of the run and the finished
 * {@link CallRecord} is the run's output. Nothing else stores a call.
 *
 * ## The shape of a call, as waits
 *
 * 1. **`dial`** — `stepPlaceCall` asks Twilio to ring the number and, once it is
 *    answered, stream the audio to this agent's `WS /phone`, carrying the
 *    signed brief (`call-params.ts`). Two attempts at most: Twilio takes no
 *    idempotency key, so a retried dial whose first answer was lost rings the
 *    phone twice.
 * 2. **`ring`** — a short durable sleep and a status read, until the call is
 *    answered or over. Polled, because a call nobody picks up never reaches a
 *    session, so nothing else would ever say "no answer".
 * 3. **The call itself** — once it is answered the run PARKS on
 *    {@link callEndedToken} until the session's `onSessionEnd` signals the
 *    transcript (`agent.ts`). Suspended, not blocked: a ten-minute call costs
 *    nothing while it runs. The window is the call's own time limit plus
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
 *
 * ## Why the transcript arrives by signal and not by a read
 *
 * The session's words live in the session, and the platform keeps no log a
 * step could read them back from afterwards. So the session hands them over
 * as it ends — the one moment it has them all and is done changing them.
 */

import type { WorkflowContext } from "@alexkroman1/aai";
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
import { signCall } from "../call-params.ts";
import { callEndedToken } from "./tokens.ts";

/** What the API hands the run. */
export type CallInput = {
  id: string;
  phone_number: string;
  prompt: string;
  webhook_url?: string | undefined;
  created_at: number;
};

/** What the answering session signals as it ends. */
export type CallEnded = {
  transcript: TranscriptTurn[];
  /** The agent judged it was talking to an answering machine (`end_call`). */
  voicemail: boolean;
  duration_seconds: number;
};

/** The longest a call may last, in seconds — Twilio hangs up at this. */
export const CALL_TIME_LIMIT_S = 600;

/** How often the run asks whether the phone has been answered. */
export const RING_POLL_MS = 5000;

/**
 * How many ring polls before the run gives up on an answer — past Twilio's own
 * 30-second ring timeout, so the carrier normally says `no-answer` first.
 */
export const MAX_RING_POLLS = 12;

/**
 * How long the run waits for the session to hand over its transcript: the
 * call's whole time limit, plus slack for the session to wind down.
 */
export const CALL_WINDOW_MS = (CALL_TIME_LIMIT_S + 120) * 1000;

/** A dial the carrier accepted, or the sentence it refused with. */
export type Dialled = { callId: string } | { refused: string };

/** The env keys the dial needs, read one at a time so a missing one is named. */
function dialEnv(): { from: string; secret: string } {
  return {
    from: requireStepEnv("TWILIO_FROM_NUMBER"),
    secret: requireStepEnv("CALLS_API_KEY"),
  };
}

/**
 * Ask Twilio to ring `phone_number` and stream the answered call to this
 * agent — `stepPlaceCall` points it at the agent's own public URL. A refusal
 * nobody can retry past — a missing env key, a bad number, no public URL —
 * comes back as `{ refused }`; anything retryable is thrown.
 */
export async function dial(input: CallInput): Promise<Dialled> {
  try {
    const env = dialEnv();
    const parameters = await signCall({ id: input.id, prompt: input.prompt }, env.secret);
    const { callId } = await stepPlaceCall({
      carrier: "twilio",
      to: input.phone_number,
      from: env.from,
      parameters,
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
    case "busy":
    case "failed":
    case "canceled":
      return status;
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

/** Write the call up in two or three sentences, against the task it was given. */
export async function summarize(
  prompt: string,
  transcript: readonly TranscriptTurn[],
): Promise<string> {
  const { summary } = await orFail(stepGenerateJson)(
    `The task the caller was given:\n${prompt}\n\nThe call:\n${transcriptText(transcript)}`,
    {
      schema: Summary,
      system:
        "You write up phone calls an AI agent placed. Say plainly what the person on the line said and decided, " +
        "and anything they asked for. Never invent details the call does not contain.",
    },
  );
  return summary;
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

  let status: PlacedCallStatus = "queued";
  for (let i = 0; i < MAX_RING_POLLS && !connected(status) && !isCallOver(status); i++) {
    await ctx.sleep("ring", RING_POLL_MS);
    status = await ctx.step("ring-status", () => readStatus(dialled.callId));
  }
  if (!connected(status)) {
    return await finish(input, callRecord(input, unansweredOutcome(status), {}), ctx);
  }

  const ended = await ctx.waitFor<CallEnded>(callEndedToken(input.id), {
    timeoutMs: CALL_WINDOW_MS,
  });
  if (ended === undefined) {
    return await finish(
      input,
      callRecord(input, "answered", {
        error: "The call was answered, but its transcript never reached this run.",
      }),
      ctx,
    );
  }

  const outcome: CallOutcome = ended.voicemail ? "voicemail" : "answered";
  const summary =
    ended.transcript.length === 0
      ? undefined
      : await ctx.step("summarize", () => summarize(input.prompt, ended.transcript));
  return await finish(
    input,
    callRecord(input, outcome, {
      transcript: ended.transcript,
      duration_seconds: ended.duration_seconds,
      ...omitUndefined({ summary }),
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
