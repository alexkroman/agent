// Copyright 2026 the AAI authors. MIT license.
/**
 * The shapes `/api/v1/calls` speaks — the one contract the run, the routes,
 * the webhook and the page all agree on.
 *
 * Plain types and nothing else, so `client.tsx` can import them without
 * pulling a line of server code into the browser bundle.
 */

/** One line of the conversation. `agent` is this app; `callee` is who picked up. */
export type TranscriptTurn = { role: "agent" | "callee"; text: string };

/**
 * Where a call is.
 *
 * `queued` until the carrier rings, `in-progress` once a session is talking,
 * `completed` when the run has written its result (whatever the outcome), and
 * `failed` when the run itself failed — never for a call nobody answered,
 * which is a `completed` call with `outcome: "no-answer"`.
 */
export type CallStatus = "queued" | "ringing" | "in-progress" | "completed" | "failed";

/**
 * How it went, once it is over.
 *
 * `answered` and `voicemail` both reached a session; the agent decides which
 * with `end_call`. The rest are the carrier's word for a call that never
 * connected.
 */
export type CallOutcome = "answered" | "voicemail" | "no-answer" | "busy" | "failed" | "canceled";

/** What `GET /api/v1/calls/:id` answers, and what the webhook is sent. */
export type CallRecord = {
  id: string;
  status: CallStatus;
  phone_number: string;
  /** Epoch ms the call was requested. */
  created_at: number;
  outcome?: CallOutcome;
  duration_seconds?: number;
  summary?: string;
  transcript: TranscriptTurn[];
  /** Why a call failed or a dial was refused, in a sentence a person can act on. */
  error?: string;
};

/** What `GET /api/v1/calls` answers: newest first. */
export type CallList = { calls: CallRecord[] };
