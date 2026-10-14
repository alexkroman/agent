// Copyright 2026 the AAI authors. MIT license.
/**
 * The calls being talked RIGHT NOW, and what has been said on each so far.
 *
 * Two readers need a call's words before the call is over, and neither can
 * reach the session that is speaking them:
 *
 * - `onSessionEnd` hands the transcript to the call's run, and is handed no
 *   slots — only the session id.
 * - `GET /api/v1/calls/:id` shows the conversation LIVE, and a route has no
 *   session at all.
 *
 * So the session's event handlers write each committed line here, keyed by
 * session id, and both readers look it up. It is per-process memory, which is
 * exactly as long as it needs to live: a call's session, its event handlers
 * and its `onSessionEnd` run in one runtime, and the entry is dropped the
 * moment the transcript has been handed over. A live view served by a
 * DIFFERENT process than the one on the call sees no live lines and shows the
 * run's status instead; the finished transcript is the run's output either
 * way.
 *
 * Bounded twice — lines per call and calls in flight — because it is fed by
 * strangers' speech.
 */

import type { TranscriptTurn } from "./api-types.ts";

/** One call in progress. */
export type LiveCall = {
  id: string;
  startedAt: number;
  transcript: TranscriptTurn[];
  voicemail: boolean;
};

/** Most lines kept for one call — a ten-minute call is well under this. */
export const MAX_LIVE_TURNS = 500;

/** Most calls held at once; the oldest is dropped past it. */
export const MAX_LIVE_CALLS = 200;

const bySession = new Map<string, LiveCall>();

/** Start following the call `sessionId` is talking on. */
export function openCall(sessionId: string, id: string, now: number): void {
  if (bySession.size >= MAX_LIVE_CALLS) {
    const oldest = bySession.keys().next().value;
    if (oldest !== undefined) bySession.delete(oldest);
  }
  bySession.set(sessionId, { id, startedAt: now, transcript: [], voicemail: false });
}

/** Add one committed line to the session's call. A session with no call is ignored. */
export function recordTurn(sessionId: string, role: TranscriptTurn["role"], text: string): void {
  const call = bySession.get(sessionId);
  const said = text.trim();
  if (call === undefined || said === "" || call.transcript.length >= MAX_LIVE_TURNS) return;
  call.transcript.push({ role, text: said });
}

/** The agent decided it reached an answering machine. */
export function markVoicemail(sessionId: string): boolean {
  const call = bySession.get(sessionId);
  if (call === undefined) return false;
  call.voicemail = true;
  return true;
}

/** Stop following the session's call, and hand back what it held. */
export function closeCall(sessionId: string): LiveCall | undefined {
  const call = bySession.get(sessionId);
  bySession.delete(sessionId);
  return call;
}

/** The call `id`, while a session on this process is still talking on it. */
export function liveCall(id: string): Readonly<LiveCall> | undefined {
  for (const call of bySession.values()) if (call.id === id) return call;
  return undefined;
}
