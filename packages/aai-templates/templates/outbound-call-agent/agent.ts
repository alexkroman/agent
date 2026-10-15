// Copyright 2026 the AAI authors. MIT license.
/**
 * An agent that MAKES phone calls — behind an HTTP API, with a page to drive
 * it and watch the transcript come back.
 *
 * ```text
 *  POST /api/v1/calls ─► run `call` ─► stepPlaceCall ─► Twilio rings the number
 *                          │                                   │ answered
 *                          │                                   ▼
 *                          │                 WS /phone ─► this agent, in a session:
 *                          │                   sessionContext — verify, read the brief
 *                          │                   events         — record each line live
 *                          │                   press_keys     — answer a phone menu
 *                          │                   end_call       — hang up (voicemail?)
 *                          ◄──── signal ──────  onSessionEnd  — hand over the transcript
 *                          ▼
 *               summarize ─► webhook ─► output = the CallRecord GET /api/v1/calls/:id reads
 * ```
 *
 * One file per concern: `api.ts` (the routes), `shared.ts` + `workflows/call.ts`
 * (the run), `call-params.ts` (what the call carries, signed), `live-calls.ts`
 * (the lines of calls in progress), `client.tsx` (the page).
 *
 * ## Setup
 *
 * | Env | What it is |
 * | --- | --- |
 * | `CALLS_API_KEY` | The `Authorization` the API requires, and the key the call brief is signed with |
 * | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | The Twilio account that dials |
 * | `TWILIO_FROM_NUMBER` | A number on that account, in E.164 — the caller id |
 *
 * Twilio is pointed back at THIS agent's public URL, which the host knows: the
 * deployed agent's own URL, or under `aai dev` the tunnel `aai dev --tunnel`
 * opens — Twilio cannot reach `localhost`.
 *
 * ## The session is a stranger until it proves otherwise
 *
 * `WS /phone` is served to anyone who finds the URL. `sessionContext` reads the
 * signed brief off the call's parameters and REFUSES any stream whose
 * signature does not verify, which hangs up before the greeting or a single
 * model call. A verified call gets its task as `instructions` — appended to
 * `system-prompt.md` for the whole session — and an empty greeting: on an
 * outbound call the person who answers speaks first.
 */

import { agent } from "@alexkroman1/aai";
import { createCall, getCall, listCalls } from "./api.ts";
import { readCall } from "./call-params.ts";
import { closeCall, openCall, recordTurn } from "./live-calls.ts";
import { call } from "./shared.ts";
import { callEndedToken } from "./workflows/tokens.ts";

/**
 * How many times `onSessionEnd` offers the transcript before giving up, and how
 * long it waits between offers. A call shorter than one ring poll can end
 * before its run has reached the wait, and `signal()` answers `false` until it
 * has — so the hand-over retries across a little more than one poll.
 */
export const HANDOVER_ATTEMPTS = 8;
export const HANDOVER_RETRY_MS = 2500;

/** Make `offer` again after `ms` — a deferral: the timer runs the offer itself. */
function offerLater(offer: () => Promise<boolean>, ms: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      offer().then(resolve, reject);
    }, ms);
  });
}

/** The task, framed as instructions for this one session. */
export function briefInstructions(prompt: string): string {
  return `## This call\n\nYou placed this call. Your task, exactly as you were given it:\n\n${prompt}`;
}

export default agent({
  name: "Outbound Caller",
  description:
    "Places phone calls from an HTTP API, carries out a task on each, and reports the transcript",
  telephony: ["twilio"],
  // The callee says "Hello?" first; the model answers it, with the task in hand.
  greeting: "",
  // The run waits on these; the API starts them. A session never does.
  workflows: { call },
  requiredEnv: ["CALLS_API_KEY", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER"],
  // Phone audio: give a callee a beat longer to finish a thought.
  turnTaking: { minSilenceMs: 1200 },

  async sessionContext({ sessionId, call: placed, env }) {
    if (placed === undefined) return { refuse: "this agent only talks on calls it placed" };
    const brief = await readCall(placed.parameters, env.CALLS_API_KEY);
    if (brief === undefined) return { refuse: "unsigned or forged call parameters" };
    openCall(sessionId, brief.id, Date.now());
    return { instructions: briefInstructions(brief.prompt), greeting: "" };
  },

  events: {
    "userTranscript.committed": (event, ctx) => recordTurn(ctx.sessionId, "callee", event.text),
    // A `recovery` line is the runtime apologizing for a failed turn, not the
    // agent's words: kept out, or the summary reports it as something said.
    "agentTranscript.committed": (event, ctx) => {
      if (event.recovery === undefined) recordTurn(ctx.sessionId, "agent", event.text);
    },
  },

  async onSessionEnd({ sessionId, workflows }) {
    const ended = closeCall(sessionId);
    if (ended === undefined) return;
    const { id } = ended;
    const payload = {
      transcript: ended.transcript,
      voicemail: ended.voicemail,
      duration_seconds: Math.round((Date.now() - ended.startedAt) / 1000),
    };
    const offer = () => workflows.signal(callEndedToken(id), payload);
    if (await offer()) return;
    for (let attempt = 2; attempt <= HANDOVER_ATTEMPTS; attempt++) {
      if (await offerLater(offer, HANDOVER_RETRY_MS)) return;
    }
    console.warn(`call ${id}: nobody took the transcript; the run will report it missing`);
  },

  routes: {
    "POST /v1/calls": createCall,
    "GET /v1/calls": listCalls,
    "GET /v1/calls/:id": getCall,
  },
});
