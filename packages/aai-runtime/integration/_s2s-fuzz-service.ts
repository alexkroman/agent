// Copyright 2026 the AAI authors. MIT license.
/**
 * The service side of the S2S property test: what the AssemblyAI S2S service is
 * holding for the session (`ServiceModel`), and the frames it can send.
 *
 * The model is what the fast-check commands' `check()` consults, which is what
 * keeps generated frames LEGAL — no audio outside a reply, no `reply.started`
 * while the service awaits a `tool.result`, no `transcript.agent` on a tool-call
 * turn (measured behaviour, see `_s2s-reply.ts`). A generator that emits what no
 * real service would produces findings that cost real time to dismiss.
 *
 * Two rules for changing anything here:
 *
 * - **A resumed session still holds its unanswered tool calls.** That is what
 *   `session.resume` MEANS — the service restores the session with its turn
 *   state intact — and it is the premise the tool-answer oracle rests on. Stop
 *   modelling it and the oracle stops meaning anything.
 * - **`syncFromReality` owns the fields reality owns.** Whether a replacement
 *   socket exists is the transport's decision, not the model's; guessing it was
 *   how an earlier draft's `check()` drifted out of step with the real link.
 *
 * @internal Test infrastructure, not part of any public API.
 */

import { FIRST_SESSION_ID, type Harness } from "./_s2s-fuzz-harness.ts";

/** What the service is holding for this session. */
export interface ServiceModel {
  /** A socket exists whose handshake has not been answered yet. */
  awaitingOpen: boolean;
  /** The live socket has completed its handshake. */
  ready: boolean;
  /** The session id the service is serving, if any. */
  sessionId: string | null;
  speech: boolean;
  replyInFlight: boolean;
  /** This reply carried a `tool.call`, so it sends no `transcript.agent`. */
  sawToolCall: boolean;
  /** The reply in flight, if any — tool results flush per reply, as a batch. */
  replyId: string | null;
  /** Tool calls issued and not yet answered — carried across a resume. */
  outstanding: Set<string>;
  /** Tool executions the session is holding open. */
  toolsInFlight: number;
  /** The client was told the session is over. */
  retired: boolean;
  /**
   * Destructive events this run may still spend — cancels, resets, drops, socket
   * errors. A BUDGET rather than a rare-pick weight because it is deterministic
   * (so shrinking stays meaningful) and says what it means: at even weight a
   * 40-command run took ~4 of them, and a tool call almost never survived long
   * enough to be answered, so the suite's central oracle ran 7 times out of 80
   * executions. Exhausting it makes those commands illegal for the rest of the
   * run, which is what leaves room for a turn to actually complete.
   */
  faultBudget: number;
  /** Monotonic id source, so frames are distinguishable in a counterexample. */
  seq: number;
}

/**
 * The state after `createHarness`: a LIVE session on socket 0. It must match the
 * harness or `check()` gates on a fiction — an earlier draft claimed
 * `awaitingOpen` on a socket that was already open, which made `Ready` illegal
 * until some `OpenSocket` command happened to resync the model, and held
 * `sessionReady` to 3 across 18 runs.
 */
export function freshModel(faultBudget: number): ServiceModel {
  return {
    faultBudget,
    awaitingOpen: false,
    ready: true,
    sessionId: FIRST_SESSION_ID,
    speech: false,
    replyInFlight: false,
    sawToolCall: false,
    replyId: null,
    outstanding: new Set(),
    toolsInFlight: 0,
    retired: false,
    seq: 0,
  };
}

/**
 * Re-read from the real system the things the real system decides: whether a
 * replacement socket exists (the transport's own resume decision), whether the
 * session has been retired, how many tools are still running, and which
 * outstanding calls have since been answered.
 */
export function syncFromReality(m: ServiceModel, h: Harness): void {
  const unopened = h.link.unopened();
  m.awaitingOpen = unopened !== undefined;
  // `ready` only ever describes a live, handshaken socket.
  const live = h.link.current();
  if (live === undefined || live.dead || m.awaitingOpen) m.ready = false;
  m.retired = h.declaredDead !== null;
  m.toolsInFlight = h.pendingTools.length;
  for (const id of [...m.outstanding]) {
    const record = h.link.calls.get(id);
    if (record !== undefined && record.answers > 0) m.outstanding.delete(id);
  }
}

/** Bump a coverage counter. */
export function hit(h: Harness, key: string): void {
  h.cov[key] = (h.cov[key] ?? 0) + 1;
}

/**
 * Answer the handshake on the live socket. A RESUME socket comes back as the
 * session it was asked to restore, carrying that session's unanswered tool calls
 * — that inheritance is what `session.resume` MEANS, and the premise the
 * tool-answer oracle rests on.
 */
export function emitReady(m: ServiceModel, h: Harness, asUpdated: boolean): void {
  const sock = h.link.current();
  if (sock === undefined) return;
  const resumed = sock.resumeRequested;
  const id = resumed ?? `sess-${sock.id}`;
  sock.sessionId = id;
  m.ready = true;
  m.sessionId = id;
  h.link.issuedSessionIds.add(id);
  if (resumed !== null) {
    hit(h, "resumeCompleted");
    if (m.outstanding.size > 0) {
      hit(h, "resume.withOutstandingTools");
      h.link.markSurvivedResume(m.outstanding);
    }
  }
  // The live API conveys the id via `session.updated.config.id` on the update
  // path and `session.ready` on the resume path; both are real.
  if (asUpdated && resumed === null) sock.deliver({ type: "session.updated", config: { id } });
  else sock.deliver({ type: "session.ready", session_id: id });
}

/** The service issues a tool call on the live socket. */
export function emitToolCall(m: ServiceModel, h: Harness): void {
  const sock = h.link.current();
  if (sock === undefined) return;
  m.seq++;
  const callId = `call-${sock.id}-${m.seq}`;
  m.sawToolCall = true;
  m.outstanding.add(callId);
  h.link.noteCall(callId, sock.id, m.replyId ?? "none");
  sock.deliver({ type: "tool.call", call_id: callId, name: "lookup", arguments: { q: "x" } });
}

/** The reply ends. Its tool results flush as a batch once the turn settles. */
export function emitReplyDone(m: ServiceModel, h: Harness, interrupted: boolean): void {
  const status = interrupted ? "interrupted" : "completed";
  h.link.endReply(status, m.outstanding);
  // An interrupted turn is abandoned service-side, results and all.
  if (interrupted) m.outstanding.clear();
  m.replyInFlight = false;
  m.replyId = null;
  h.link.current()?.deliver({ type: "reply.done", status });
}

/** The socket dies under the session. */
export function emitDrop(m: ServiceModel, h: Harness, code: number, reason: string): void {
  m.faultBudget--;
  m.ready = false;
  m.speech = false;
  m.replyInFlight = false;
  h.link.current()?.drop(code, reason);
}
