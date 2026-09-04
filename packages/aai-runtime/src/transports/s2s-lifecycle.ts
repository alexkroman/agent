// Copyright 2026 the AAI authors. MIT license.
/**
 * The S2S connection's lifecycle, as a statechart.
 *
 * This was four latches in `s2s-transport.ts` — `closing`, `sessionEnded`,
 * `reconnecting`, and a `resumeAttempts` counter — plus a nullable
 * `providerSessionId`, and the cost showed up in two places:
 *
 * - **Every latch was also a dedup.** `endSession` opened with
 *   `if (sessionEnded) return`, `failResume` with `if (!reconnecting) return`,
 *   and `handleClose` with one guard per latch. Each said "this transition is
 *   only legal from one place", which is what a state IS. Here `ended` has no
 *   outgoing lifecycle transition and a failed resume is reachable only from
 *   `resuming`, so those dedups are gone rather than trusted.
 * - **The resume was fire-and-forget.** `void resume(prevId).catch(...)` had no
 *   owner, so a resume settling after the client hung up had to ask afterwards
 *   whether it still mattered — the `if (closing || sessionEnded)` re-checks
 *   that appeared three times. As an `invoke`, leaving `resuming` stops the
 *   actor and neither its resolution nor its rejection fires.
 *
 * Sixteen combinations of four booleans described five positions, and the
 * illegal ones were reachable: `closing && reconnecting` is a client that hung
 * up mid-resume, which the fuzz
 * (`integration/s2s-fuzz.integration.test.ts`) found as a half-open, billed
 * provider socket pinned for the life of the process.
 *
 * **Effects stay in the transport.** The machine owns WHEN; every HOW — closing
 * a handle, reporting the fatal error, redelivering queued tool results —
 * arrives as an injected {@link S2sLifecycleEffects} call, the same shape
 * `createGatedSpeechEdges` uses in pipeline-speech-edges.ts. So this module
 * touches no socket, which is what makes the ordering rules testable without a
 * connection.
 */

import { S2S_MAX_RESUME_ATTEMPTS } from "@alexkroman1/aai/host-internal";
import { errorMessage } from "@alexkroman1/aai/utils";
import { and, assign, createActor, fromPromise, setup } from "xstate";

/**
 * Where the connection is.
 *
 * `ended` and `closed` are both terminal and are NOT the same thing: `ended` is
 * the session dying under us (reported to the client exactly once), `closed` is
 * the client hanging up (reported to nobody — it asked). Collapsing them is how
 * a client-initiated close would surface as a connection error.
 */
export type S2sPhase = "connecting" | "live" | "resuming" | "ended" | "closed";

/**
 * The transport's side of the machine: everything the lifecycle decides to do
 * but does not know how to.
 */
export type S2sLifecycleEffects = {
  /**
   * Open a replacement socket and send `session.resume` for `sessionId`.
   * Rejects when the socket never opens — one of the two ways a resume fails,
   * the other being a close before `session.ready`.
   */
  resume(sessionId: string): Promise<void>;
  /**
   * Drop the link: close the handle, forget it, and discard anything queued for
   * it.
   *
   * Runs on every path into `ended`, including the one where the socket is
   * still OPEN — the service rejects a `session.resume` with
   * `session_not_found` IN BAND and leaves the link up, and the transport used
   * to go on relaying that live (billed) session's frames to a client it had
   * just told the call was over.
   */
  dropLink(): void;
  /** Ask the peer to hang up, leaving the close path to react to it. */
  closeHandle(): void;
  /** Report the ONE fatal error that ends this session. */
  reportFatal(detail: string): void;
  /** Tell the session core the reply that was in flight is gone. */
  cancelInFlightReply(): void;
  /** Redeliver tool results a dead socket dropped. */
  flushPendingToolResults(): void;
  /** The reply in flight, for the diagnostics on a mid-reply close. */
  currentReplyId(): string | null;
  /** Structured, prefixed log — the transport supplies `sid`/`agent`. */
  log(level: "info" | "warn", message: string, fields?: Record<string, unknown>): void;
};

/** Everything that happens to a connection. */
export type S2sLifecycleEvent =
  /** `session.ready` — the provider named (or renamed) the session. */
  | { type: "READY"; sessionId: string }
  /** A reply started: the session is demonstrably healthy again. */
  | { type: "PROGRESS" }
  /** The socket closed. `transient` is the close code's own verdict. */
  | { type: "CLOSED"; code: number; reason: string; transient: boolean }
  /** The service says the session no longer exists. */
  | { type: "EXPIRED" }
  /** The client hung up. */
  | { type: "STOP" };

type Context = {
  effects: S2sLifecycleEffects;
  /** The id to resume, or null once the session is unresumable. */
  providerSessionId: string | null;
  /** Consecutive resume attempts with no reply in between. */
  resumeAttempts: number;
};

/**
 * The detail line for a close that ends the session, chosen by what was lost.
 * Logs as it decides, because the diagnostic fields differ per arm.
 */
function fatalCloseDetail(effects: S2sLifecycleEffects, code: number, reason: string): string {
  const activeReplyId = effects.currentReplyId();
  if (activeReplyId !== null) {
    effects.log("warn", "S2S closed with active reply", { activeReplyId, code, reason });
    return `S2S closed mid-reply (code=${code})`;
  }
  // An unexpected close with no reply in flight is NOT harmless: a
  // client-initiated close is absorbed by `closed` and a session already
  // declared dead by `ended`, so reaching here means the provider dropped a
  // live idle session. Staying silent left the client "connected" while every
  // later utterance vanished into a dead handle until the idle timeout.
  effects.log("warn", "S2S closed unexpectedly while idle", { code, reason });
  return `S2S closed unexpectedly (code=${code})`;
}

/** Retire the session: drop the link first, then report it once. */
function retire(effects: S2sLifecycleEffects, detail: string): void {
  effects.dropLink();
  effects.reportFatal(detail);
}

const s2sLifecycleMachine = setup({
  types: {} as { context: Context; input: S2sLifecycleEffects; events: S2sLifecycleEvent },
  actors: {
    /**
     * The replacement socket. An actor rather than a bare `void resume(...)`
     * precisely so that leaving `resuming` — a client hanging up, a close
     * arriving first — stops it, instead of letting it settle into a session
     * that is already over.
     */
    resumeSocket: fromPromise(
      ({ input }: { input: { effects: S2sLifecycleEffects; sessionId: string } }) =>
        input.effects.resume(input.sessionId),
    ),
  },
  guards: {
    /**
     * Is this close worth a `session.resume`? The close code's own verdict AND
     * a session id to resume. "Not already resuming" needs no test: a close
     * arriving in `resuming` is that state's business, as a failed resume.
     */
    canResume: ({ context, event }) =>
      event.type === "CLOSED" && event.transient && context.providerSessionId !== null,
    /** A flapping server that keeps accepting a resume then dropping it. */
    budgetSpent: ({ context }) => context.resumeAttempts >= S2S_MAX_RESUME_ATTEMPTS,
  },
  actions: {
    rememberSession: assign({
      providerSessionId: ({ context, event }) =>
        event.type === "READY" ? event.sessionId : context.providerSessionId,
    }),
    /** The session is no longer resumable — nothing may try again. */
    forgetSession: assign({ providerSessionId: null }),
    spendResumeAttempt: assign({ resumeAttempts: ({ context }) => context.resumeAttempts + 1 }),
    /** A reply landed, so a session that drops once always gets a fresh budget. */
    resetResumeBudget: assign({ resumeAttempts: 0 }),
    /** Everything a `session.ready` owes the session core. */
    admitReady: ({ context }) => {
      context.effects.flushPendingToolResults();
    },
    /** The service retired the session: hang up and let the close path react. */
    expireHandle: ({ context }) => {
      context.effects.log("info", "S2S session expired");
      context.effects.closeHandle();
    },
    /** A close with nothing left to resume. */
    retireOnClose: ({ context, event }) => {
      if (event.type !== "CLOSED") return;
      retire(context.effects, fatalCloseDetail(context.effects, event.code, event.reason));
    },
    /** A resumable close whose budget is spent. */
    abandonResume: ({ context, event }) => {
      if (event.type !== "CLOSED") return;
      context.effects.log("warn", "S2S giving up on resume — attempt cap reached", {
        attempts: context.resumeAttempts,
        code: event.code,
      });
      retire(
        context.effects,
        `S2S resume abandoned after ${context.resumeAttempts} attempts (code=${event.code})`,
      );
    },
    /** Announce the attempt and free the turn the dead socket was serving. */
    announceResume: ({ context, event }) => {
      if (event.type !== "CLOSED") return;
      context.effects.log("warn", "S2S unexpected close — attempting resume", {
        code: event.code,
        reason: event.reason,
        prevSessionId: context.providerSessionId,
      });
      // The in-flight reply is gone; unblock ServerSession's turn promise.
      context.effects.cancelInFlightReply();
    },
    /** The replacement socket closed before it reported ready. */
    failResumeOnClose: ({ context, event }) => {
      if (event.type !== "CLOSED") return;
      retire(context.effects, `S2S resume failed (code=${event.code})`);
    },
    /** The service rejected the resume in band — the socket may still be open. */
    failResumeExpired: ({ context }) => {
      context.effects.log("warn", "S2S resume rejected: session expired");
      retire(context.effects, "S2S resume failed: session expired");
    },
  },
}).createMachine({
  id: "s2sLifecycle",
  context: ({ input }) => ({ effects: input, providerSessionId: null, resumeAttempts: 0 }),
  initial: "connecting",
  on: {
    // Root-level, because both are facts about the connection rather than about
    // any one position in its life. A `STOP` in `closed` re-enters it, which is
    // harmless — every teardown effect is idempotent — and cheaper than a guard
    // whose only job is to describe a call ServerSession makes once.
    PROGRESS: { actions: "resetResumeBudget" },
    STOP: { target: ".closed" },
  },
  states: {
    /** The first handshake is in flight; `start()` owns its promise. */
    connecting: {
      on: {
        READY: {
          target: "live",
          actions: [
            "rememberSession",
            ({ context, event }) =>
              context.effects.log("info", "S2S session ready", { sessionId: event.sessionId }),
            "admitReady",
          ],
        },
        EXPIRED: { actions: "expireHandle" },
        // Nothing to resume before the provider has named a session, so the
        // `canResume` guard would decline anyway — stated as one branch here
        // because a close in `connecting` is always the end.
        CLOSED: { target: "ended", actions: "retireOnClose" },
      },
    },
    /** A named provider session on an open socket. */
    live: {
      on: {
        // A later `session.ready` renames the session with no log line — it is
        // neither a first ready nor a resume.
        READY: { actions: ["rememberSession", "admitReady"] },
        EXPIRED: { actions: "expireHandle" },
        CLOSED: [
          {
            guard: and(["canResume", "budgetSpent"]),
            target: "ended",
            actions: ["abandonResume", "forgetSession"],
          },
          {
            guard: "canResume",
            target: "resuming",
            actions: ["spendResumeAttempt", "announceResume"],
          },
          { target: "ended", actions: "retireOnClose" },
        ],
      },
    },
    /**
     * A replacement socket is opening and will send `session.resume`.
     *
     * Three ways out, and the machine is what makes them exclusive: the resumed
     * session reports ready, the new socket closes before it does, or the
     * handshake itself rejects. Each used to need the `reconnecting` latch to
     * stop the other two reporting the same failure a second time.
     */
    resuming: {
      invoke: {
        src: "resumeSocket",
        input: ({ context }) => ({
          effects: context.effects,
          // Non-null by the `canResume` guard on the one edge into this state.
          sessionId: context.providerSessionId ?? "",
        }),
        onError: {
          target: "ended",
          actions: [
            "forgetSession",
            ({ context, event }) => {
              const detail = errorMessage(event.error);
              context.effects.log("warn", "S2S resume failed", { error: detail });
              retire(context.effects, `S2S resume failed: ${detail}`);
            },
          ],
        },
      },
      on: {
        READY: {
          target: "live",
          actions: [
            "rememberSession",
            ({ context, event }) =>
              context.effects.log("info", "S2S resumed", { sessionId: event.sessionId }),
            "admitReady",
          ],
        },
        CLOSED: { target: "ended", actions: ["forgetSession", "failResumeOnClose"] },
        EXPIRED: { target: "ended", actions: ["forgetSession", "failResumeExpired"] },
      },
    },
    /**
     * The session died under us and the client has been told, exactly once.
     *
     * Not `type: "final"`: the actor has to stay alive to absorb the trailing
     * close from the socket `retire` just shut, and to keep answering
     * {@link S2sLifecycle.acceptsInbound} for frames still buffered behind it.
     */
    ended: {
      on: {
        CLOSED: {
          actions: ({ context, event }) =>
            context.effects.log("info", "S2S trailing close after session ended", {
              code: event.code,
              reason: event.reason,
            }),
        },
      },
    },
    /**
     * The client hung up. Nothing here is an error and nothing is reported.
     *
     * The teardown itself deliberately does NOT live here as an entry action.
     * XState catches what an action throws and turns it into an actor error, so
     * a `handle.close()` that threw stopped propagating out of the transport's
     * `stop()` — and the runtime's shutdown warning ("Session stop failed
     * during shutdown") is the only thing that tells an operator a provider
     * link leaked. `stop()` sends `STOP` for the phase, which is what stops any
     * resume in flight, and then tears down itself.
     */
    closed: {
      on: {
        CLOSED: {
          actions: ({ context, event }) =>
            context.effects.log("info", "S2S closed", { code: event.code, reason: event.reason }),
        },
      },
    },
  },
});

/** The transport's handle on its own lifecycle. */
export type S2sLifecycle = {
  /** Where the connection is. */
  phase(): S2sPhase;
  /**
   * May an inbound provider frame still be relayed to the client?
   *
   * False in both terminal phases and nowhere else. `close()` asks the peer to
   * hang up — it does not un-deliver what is already buffered, so `ws` goes on
   * emitting `message` events after a session is retired, and every one of
   * those would reach a client that has released its microphone.
   */
  acceptsInbound(): boolean;
  /** The provider session id, once one has been named. */
  sessionId(): string | null;
  send(event: S2sLifecycleEvent): void;
};

/** Create the lifecycle for one S2S transport. */
export function createS2sLifecycle(effects: S2sLifecycleEffects): S2sLifecycle {
  const actor = createActor(s2sLifecycleMachine, { input: effects }).start();
  const phase = (): S2sPhase => actor.getSnapshot().value;
  return {
    phase,
    acceptsInbound: () => {
      const at = phase();
      return at !== "ended" && at !== "closed";
    },
    sessionId: () => actor.getSnapshot().context.providerSessionId,
    send: (event) => actor.send(event),
  };
}
