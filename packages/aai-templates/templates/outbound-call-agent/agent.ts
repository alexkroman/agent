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
 *                          │                   press_keys     — answer a phone menu
 *                          │                   end_call       — hang up
 *                          ◄──── signal ──────  onSessionEnd  — hand over the transcript
 *                          ▼
 *               summarize ─► webhook ─► output = the CallRecord GET /api/v1/calls/:id reads
 * ```
 *
 * One file per concern: `api.ts` (the routes), `workflows/call.ts` (the run and
 * its declaration), `client.tsx` (the page).
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
 * brief `stepPlaceCall` signed onto the call's parameters — `call.brief(secret)`
 * verifies it — and REFUSES any stream whose signature does not verify, which
 * hangs up before the greeting or a single model call. A verified call gets its
 * task as `instructions` for the whole session, and an empty greeting: on an
 * outbound call the person who answers speaks first.
 *
 * ## The transcript is the session's, handed over as it ends
 *
 * `onSessionEnd` is given every committed line of the call and signals it to
 * the run, which has been parked on the call since the phone was answered. A
 * call shorter than one ring poll can end before its run has reached that
 * wait, so the signal is HELD for the run to claim rather than answered `false`.
 */

import { agent } from "@alexkroman1/aai";
import { DEFAULT_SIGNAL_HOLD_MS } from "@alexkroman1/aai/workflow-api";
import { createCall, getCall, listCalls } from "./api.ts";
import type { TranscriptTurn } from "./api-types.ts";
import type { CallEnded } from "./workflows/call.ts";
import { callEndedToken } from "./workflows/tokens.ts";

/** The task, framed as instructions for this one session. */
export function briefInstructions(prompt: string): string {
  return `## This call\n\nYou placed this call. Your task, exactly as you were given it:\n\n${prompt}`;
}

/** The session's own transcript, in the API's words: the callee spoke, the agent answered. */
export function callEnded(
  transcript: readonly { role: string; text: string; at: number }[],
): CallEnded {
  const first = transcript[0]?.at;
  const last = transcript.at(-1)?.at;
  return {
    transcript: transcript.map(
      (line): TranscriptTurn => ({
        role: line.role === "user" ? "callee" : "agent",
        text: line.text,
      }),
    ),
    duration_seconds:
      first === undefined || last === undefined ? 0 : Math.round((last - first) / 1000),
  };
}

export default agent({
  name: "Outbound Caller",
  listing:
    "Places phone calls from an HTTP API, carries out a task on each, and reports the transcript",
  telephony: ["twilio"],
  // The callee says "Hello?" first; the model answers it, with the task in hand.
  greeting: "",
  requiredEnv: ["CALLS_API_KEY", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER"],
  // Phone audio: give a callee a beat longer to finish a thought.
  turnTaking: { minSilenceMs: 1200 },

  async sessionContext({ call, env }) {
    if (call === undefined) return { refuse: "this agent only talks on calls it placed" };
    const brief = await call.brief(env.CALLS_API_KEY);
    if (brief === undefined) return { refuse: "unsigned or forged call parameters" };
    return { instructions: briefInstructions(brief.prompt), greeting: "" };
  },

  async onSessionEnd({ call, env, transcript, workflows }) {
    const brief = await call?.brief(env.CALLS_API_KEY);
    if (brief === undefined) return;
    const taken = await workflows.signal(callEndedToken(brief.id), callEnded(transcript), {
      holdMs: DEFAULT_SIGNAL_HOLD_MS,
    });
    if (!taken)
      console.warn(`call ${brief.id}: nobody took the transcript; the run will report it missing`);
  },

  routes: {
    "POST /v1/calls": createCall,
    "GET /v1/calls": listCalls,
    "GET /v1/calls/:id": getCall,
  },
});
