// Copyright 2026 the AAI authors. MIT license.
/**
 * The browser session's {@link AgentState}, and the error beside it, as a
 * statechart.
 *
 * These two were written independently from thirteen sites across
 * `session-core.ts`, `session-core-messages.ts` and
 * `session-core-audio-setup.ts`, each one deciding for itself whether its write
 * was legal by reading the snapshot back first. Three shipped bugs came out of
 * that, and all three are the same shape — a transition nothing forbade:
 *
 * - **A straggler audio chunk flipped an errored session to `"speaking"`.**
 *   Guarded by hand at the call site
 *   (`if (snap.state === "error" || (snap.state === "disconnected" && …))`).
 *   Here `error` simply does not handle `SPEAK`.
 * - **The frame that announced a session's death also wiped the banner
 *   reporting it.** Every fatal path in the host tears the transport down, and
 *   tearing down EMITS — so `reply.cancelled` arrived right behind the error and
 *   `toListening()` painted a live-mic state over it. A missing provider key is
 *   the case that made it visible: the one message that says exactly what to fix
 *   was on screen for a few hundred milliseconds and left a session that looked
 *   live and was deaf.
 * - **A later frame RECOVERED the state.** `clearRecoveredError` reads a
 *   non-error frame as proof the session works, which is right for a
 *   turn-level failure and wrong for a server error that ended the call.
 *
 * The second and third were fixed with a `conn.fatalError` boolean that every
 * writer had to remember to consult. It is the `fatal` region here, so
 * forgetting is not available: `LISTEN` and `ACTIVITY` are declined in one
 * place rather than at each of their five call sites.
 *
 * ## Two regions, because the fatal latch OUTLIVES the error state
 *
 * `fatal` is not a substate of `error`, tempting as that looks. It is cleared by
 * exactly one thing — the next `config` frame, i.e. a completed handshake — and
 * that is per CONNECTION rather than per session, so a reconnect that really
 * works is not pinned to a dead session's banner. Between the error and that
 * frame the phase runs `error → connecting → ready` while the latch stays set,
 * which a substate cannot express.
 *
 * ## The published surface is unchanged
 *
 * {@link AgentState} is a public type in the versioned `aai-ui:session`
 * capability, so {@link AgentStateSnapshot.state} is one of its seven names and
 * nothing here widens it. The internal distinctions live in the second region
 * and in context, not in the projection.
 */

import { and, assign, createActor, not, setup, stateIn } from "xstate";
import type { AgentState, SessionError } from "./types.ts";

/** What the session core folds into its snapshot after each transition. */
export type AgentStateSnapshot = {
  state: AgentState;
  error: SessionError | null;
};

/**
 * Everything that moves the session's state.
 *
 * Named for what HAPPENED rather than for the state wanted, which is the point:
 * `reply.cancelled` sends `LISTEN` and gets `"error"` back when the session is
 * fatally over, and the caller neither knows nor needs to.
 */
export type AgentStateEvent =
  /** A connect attempt started — including a reconnect or a handshake retry. */
  | { type: "CONNECT" }
  /** The socket opened; the handshake has not completed yet. */
  | { type: "SOCKET_OPEN" }
  /** A completed handshake: a live session, whatever ended the last one. */
  | { type: "HANDSHAKE_COMPLETE" }
  /** A turn boundary, or the audio path coming up: back to the mic. */
  | { type: "LISTEN" }
  /** A reset: back to the mic AND the conversation cleared. */
  | { type: "RESET" }
  /** The agent is working. */
  | { type: "THINK" }
  /** Audio for this turn reached the client. */
  | { type: "SPEAK" }
  /** A non-error frame arrived, so the session demonstrably works. */
  | { type: "ACTIVITY" }
  /** A turn-level failure: a banner over a session that keeps running. */
  | { type: "TURN_ERROR"; error: SessionError }
  /** The session is over. */
  | { type: "FATAL"; error: SessionError }
  /**
   * A failure that stops the session but might not be the end of it: the
   * handshake exhausting its retries, a socket error close, or the audio path
   * dying. The `fatal` latch stays clear, so a later non-error frame recovers
   * — which is right for a client-side failure and is exactly what a FATAL
   * server error must not get.
   */
  | { type: "FAILED"; error: SessionError }
  /** The socket closed for good. */
  | { type: "CLOSED" }
  /** The caller hung up. */
  | { type: "DISCONNECT" }
  /** The caller ended the session and forgot it. */
  | { type: "END" };

type Context = { error: SessionError | null };

/**
 * Not fatally over — so a working state may be painted.
 *
 * `stateIn` reads the sibling REGION rather than a mirror of it in context,
 * which is what keeps `fatal` the one place the latch lives. The three events
 * this guards are the three that used to consult `conn.fatalError` by hand at
 * five call sites; `THINK` is a fourth that did not, and should have — the doc
 * on that flag says outright that "no later frame may take its banner off the
 * screen", and a `user-transcript.committed` arriving behind a fatal error
 * painted `"thinking"` over it.
 */
const NOT_FATAL = not(stateIn({ fatal: "yes" }));

const sessionStateMachine = setup({
  types: {} as { context: Context; events: AgentStateEvent },
  guards: {
    /** A banner is still up from a failure the session survived. */
    hasError: ({ context }) => context.error !== null,
  },
  actions: {
    clearError: assign({ error: null }),
    setError: assign({
      error: ({ context, event }) =>
        event.type === "TURN_ERROR" || event.type === "FATAL" || event.type === "FAILED"
          ? event.error
          : context.error,
    }),
  },
}).createMachine({
  id: "sessionState",
  type: "parallel",
  context: { error: null },
  states: {
    /** The seven names {@link AgentState} publishes. */
    phase: {
      initial: "disconnected",
      // Declared once at the region rather than on each of seven states: these
      // are legal from anywhere, which is a fact about the connection rather
      // than about any position in a call.
      on: {
        CONNECT: { target: ".connecting", actions: "clearError" },
        // A clean close retires a lingering non-fatal banner. A close while the
        // phase is already `error` keeps it — see that state's own handler.
        CLOSED: { target: ".disconnected", actions: "clearError" },
        // `disconnect()` does NOT clear the error: the banner explaining why a
        // session ended has to survive the hang-up that follows it.
        DISCONNECT: ".disconnected",
        END: { target: ".disconnected", actions: "clearError" },
        TURN_ERROR: { actions: "setError" },
        FATAL: { target: ".error", actions: "setError" },
        FAILED: { target: ".error", actions: "setError" },
        LISTEN: { guard: NOT_FATAL, target: ".listening" },
        RESET: { guard: NOT_FATAL, target: ".listening", actions: "clearError" },
        THINK: { guard: NOT_FATAL, target: ".thinking" },
        // A non-error frame is proof the session works, so it retires a
        // lingering banner. It does NOT move the phase on its own — only a
        // phase that IS the banner recovers, which `error` declares below.
        //
        // `NOT_FATAL` is here as well as on `error`'s own handler, and it has
        // to be: when a CHILD's guard fails XState falls through to the
        // ancestor's handler for the same event, so a fatal session in `error`
        // declined the recovery below and then had its banner cleared by this
        // one. `fuzz-session-core.test.ts` found it in four ops — start,
        // error_fatal, any later frame — and shrank to "error state carries no
        // error", which is the illegal pair this machine exists to prevent.
        ACTIVITY: { guard: and([NOT_FATAL, "hasError"]), actions: "clearError" },
      },
      states: {
        disconnected: {
          on: {
            // A straggler chunk for a session that ended cleanly still plays;
            // one for a session that FAILED must not paint over its banner.
            SPEAK: { guard: not("hasError"), target: "speaking" },
          },
        },
        connecting: { on: { SOCKET_OPEN: "ready" } },
        ready: { on: { SPEAK: "speaking" } },
        listening: { on: { SPEAK: "speaking" } },
        thinking: { on: { SPEAK: "speaking" } },
        speaking: {},
        /**
         * A failure is on screen.
         *
         * `SPEAK` is absent deliberately — that is half the guard
         * `playAudioChunk` used to spell, and the other half is `disconnected`'s
         * above. `ACTIVITY` recovers to `listening` rather than merely clearing
         * the banner: the socket is demonstrably open (we are handling a server
         * event), so `disconnected` would misreport a live session.
         */
        error: {
          on: {
            ACTIVITY: { guard: NOT_FATAL, target: "listening", actions: "clearError" },
            // The socket closing behind an error keeps the error: downgrading
            // it to `disconnected` would hide why the session ended.
            CLOSED: {},
          },
        },
      },
    },
    /**
     * Whether the session is fatally over.
     *
     * Separate from `phase` because it OUTLIVES the `error` state: only a
     * completed handshake clears it, and the phase moves through `connecting`
     * and `ready` on the way to one. A substate of `error` could not say that.
     */
    fatal: {
      initial: "no",
      states: {
        no: { on: { FATAL: "yes" } },
        yes: { on: { HANDSHAKE_COMPLETE: "no" } },
      },
    },
  },
});

/** The session core's handle on its own state. */
export type SessionStateMachine = {
  /** The published state and the error beside it. */
  snapshot(): AgentStateSnapshot;
  /**
   * Apply `event` and return the resulting projection.
   *
   * Returns rather than writes so the caller folds it into ONE `updateState`
   * call: a snapshot is published on every write, and splitting one transition
   * into two would let a subscriber render half of it.
   */
  apply(event: AgentStateEvent): AgentStateSnapshot;
  /**
   * Is the session fatally over? Asked by the one caller that has to clear the
   * CONVERSATION and not merely the state — a `session.reset` on a dead session
   * keeps its whole banner.
   */
  fatal(): boolean;
};

/** Create the state machine for one browser session. */
export function createSessionStateMachine(): SessionStateMachine {
  const actor = createActor(sessionStateMachine).start();

  function snapshot(): AgentStateSnapshot {
    const at = actor.getSnapshot();
    return { state: at.value.phase, error: at.context.error };
  }

  return {
    snapshot,
    apply(event: AgentStateEvent): AgentStateSnapshot {
      actor.send(event);
      return snapshot();
    },
    fatal: () => actor.getSnapshot().matches({ fatal: "yes" }),
  };
}
