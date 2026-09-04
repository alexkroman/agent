// Copyright 2026 the AAI authors. MIT license.
/**
 * The OpenAI Realtime connection's lifecycle, as a statechart.
 *
 * The sibling of `s2s-lifecycle.ts`, written for the same reasons and against
 * the same two symptoms — read that module's doc first; this one only records
 * what is different about the second S2S transport.
 *
 * This was two latches in `openai-realtime-transport.ts`, `closing` and
 * `replyInFlight`, and the reply half is the one that had visibly gone wrong:
 *
 * - **The reply reset was written three times.** `response.done`, the
 *   server-VAD barge-in and `cancelReply()` each ran
 *   `replyInFlight = false; clearTurnBuffers();`, and one of them carried the
 *   comment "Mirrors `cancelReply()`'s local state reset." A reset that has to
 *   say it mirrors another reset is an EXIT ACTION that has not been named: it
 *   is here, on `replying`, so the three paths differ only in what they report.
 * - **The state that must NOT reset needed nine lines of prose.** An in-band
 *   `error` interrupts a response that is still running, so its transcript
 *   buffer is live state rather than turn residue — clearing it left the later
 *   `…transcript.done` reading `""`, which suppresses the emit, so the caller
 *   heard the whole reply and nothing entered history. As a state, that is just
 *   "this event does not leave `replying`", and the comment is a sentence.
 * - **Both latches were also dedups.** `cancelReply()` opened with
 *   `if (!replyInFlight) return` and the barge-in with `if (replyInFlight)`;
 *   both events are now handled in `replying` and nowhere else.
 *
 * **`replying` is a SUBSTATE of `live`, not a parallel region**, which is what
 * makes "a reply in flight on a socket we have hung up" unrepresentable.
 * `stop()` used to leave `replyInFlight` true, so a `response.created` arriving
 * after it still called `onReplyStarted` on a session the client had ended, and
 * a late `cancelReply()` still passed its guard. Neither is reachable now.
 *
 * `ended` and `closed` mean what they mean in the sibling: the session dying
 * under us, reported exactly once, versus the client hanging up, reported to
 * nobody. Two things this machine deliberately does NOT own: the socket (the
 * transport keeps `ws`, so this module is testable without a connection) and
 * the microtask coalescing behind `response.create` — that is a send-side
 * batch with no position in the connection's life, and modelling it would cost
 * an invoked actor to express a `queueMicrotask`. It is not
 * `createCoalescingRunner` either: that runs a TRAILING re-run after the
 * current one settles, where this must collapse a tick's calls into one frame
 * and send nothing more.
 */

import { assign, createActor, setup } from "xstate";

/** Where the connection is. `live` carries the reply substate. */
export type OpenaiRealtimePhase = "connecting" | "live" | "ended" | "closed";

/**
 * The transport's side of the machine: everything the lifecycle decides to do
 * but does not know how to.
 */
export type OpenaiRealtimeLifecycleEffects = {
  /** A reply began — the provider's `response.id`, for the session core. */
  replyStarted(replyId: string): void;
  /** The reply in flight finished on its own. */
  replyCompleted(): void;
  /** The reply in flight was abandoned; tell the client to flush playback. */
  replyCancelled(): void;
  /** Ask OpenAI to abandon the response in flight. */
  cancelResponse(): void;
  /**
   * Drop the turn's transcript and tool-argument buffers.
   *
   * The exit action of `replying`, so it runs on every way out of a reply and
   * on no other event — see the module doc.
   */
  clearTurnBuffers(): void;
  /** Report the ONE fatal error that ends this session. */
  reportFatal(detail: string): void;
  /** Structured, prefixed log — the transport supplies `sid`. */
  log(level: "info" | "warn", message: string, fields?: Record<string, unknown>): void;
};

/** Everything that happens to a connection. */
export type OpenaiRealtimeLifecycleEvent =
  /** The socket opened. */
  | { type: "OPEN" }
  /** `response.created` — the provider started a reply. */
  | { type: "REPLY_STARTED"; replyId: string }
  /** `response.done` — the reply ended on its own. */
  | { type: "REPLY_DONE" }
  /**
   * `input_audio_buffer.speech_started` — the caller began speaking.
   *
   * Under server VAD this is also a barge-in: OpenAI cancels the in-flight
   * response its own side, and nothing else tells the client to flush the audio
   * it has already buffered, so the interrupted reply plays out over the caller.
   * The transport reports `speech.started` regardless of what this does here.
   */
  | { type: "SPEECH_STARTED" }
  /** The session core asked for the reply in flight to be abandoned. */
  | { type: "CANCEL" }
  /** The socket closed. */
  | { type: "CLOSED"; code: number; reason: string }
  /** The client hung up. */
  | { type: "STOP" };

type Context = {
  effects: OpenaiRealtimeLifecycleEffects;
  /**
   * The reply in flight, for diagnostics on a mid-reply close.
   *
   * Held rather than discarded because the id is the only thing that makes a
   * close log answerable — the transport's own `replyInFlight` was a boolean
   * and its comment said the id "is passed straight to onReplyStarted, never
   * correlated later", which is why a close mid-reply named nothing.
   */
  replyId: string | null;
};

const openaiRealtimeLifecycleMachine = setup({
  types: {} as {
    context: Context;
    input: OpenaiRealtimeLifecycleEffects;
    events: OpenaiRealtimeLifecycleEvent;
  },
  actions: {
    /** Remember the reply and hand its id to the session core. */
    announceReply: assign(({ context, event }) => {
      if (event.type !== "REPLY_STARTED") return {};
      context.effects.replyStarted(event.replyId);
      return { replyId: event.replyId };
    }),
    forgetReply: assign({ replyId: null }),
    clearTurnBuffers: ({ context }) => context.effects.clearTurnBuffers(),
    reportCompleted: ({ context }) => context.effects.replyCompleted(),
    reportCancelled: ({ context }) => context.effects.replyCancelled(),
    /**
     * Ask the provider to stop, and report NOTHING.
     *
     * The session's own `cancel` command is the only caller and emits
     * `reply.cancelled` itself, so firing it here would double-emit the frame.
     * The S2S and pipeline transports follow the same rule.
     */
    cancelResponse: ({ context }) => context.effects.cancelResponse(),
    /** A close nobody asked for: the socket is gone, so the session is over. */
    retireOnClose: ({ context, event }) => {
      if (event.type !== "CLOSED") return;
      const { code, reason } = event;
      if (context.replyId !== null) {
        context.effects.log("warn", "OpenAI Realtime closed with active reply", {
          activeReplyId: context.replyId,
          code,
          reason,
        });
      } else {
        context.effects.log("warn", "OpenAI Realtime closed unexpectedly", { code, reason });
      }
      context.effects.reportFatal(`OpenAI Realtime closed (code=${code})`);
    },
    logExpectedClose: ({ context, event }) => {
      if (event.type !== "CLOSED") return;
      context.effects.log("info", "OpenAI Realtime closed", {
        code: event.code,
        reason: event.reason,
      });
    },
  },
}).createMachine({
  id: "openaiRealtimeLifecycle",
  context: ({ input }) => ({ effects: input, replyId: null }),
  initial: "connecting",
  on: {
    // Root-level, for the sibling's reason: hanging up is a fact about the
    // connection rather than about any one position in its life. Leaving `live`
    // this way runs `replying`'s exit action, so a client who hangs up
    // mid-reply does not leave a turn's buffers behind.
    STOP: { target: ".closed" },
  },
  states: {
    /** The socket is opening; `start()` owns its promise. */
    connecting: {
      on: {
        OPEN: { target: "live" },
        CLOSED: { target: "ended", actions: "retireOnClose" },
      },
    },
    /** An open socket. The substate is whether a reply is in flight. */
    live: {
      initial: "idle",
      on: { CLOSED: { target: "ended", actions: "retireOnClose" } },
      states: {
        idle: {
          // The reset lives on the way IN to `idle` rather than on the way out
          // of `replying`, and the difference is load-bearing: XState runs a
          // source state's exit actions BEFORE the transition's own, so
          // forgetting the id on exit emptied it before `retireOnClose` could
          // name the reply a mid-reply close had just lost. Entering `idle` is
          // the one way a reply ends without the session ending with it.
          entry: "forgetReply",
          on: { REPLY_STARTED: { target: "replying", actions: "announceReply" } },
        },
        replying: {
          exit: "clearTurnBuffers",
          on: {
            REPLY_DONE: { target: "idle", actions: "reportCompleted" },
            SPEECH_STARTED: { target: "idle", actions: "reportCancelled" },
            CANCEL: { target: "idle", actions: "cancelResponse" },
            // Action-only, so it does NOT re-enter `replying` and therefore does
            // not clear the buffers of the reply it renames. The provider is not
            // supposed to open a second response without closing the first;
            // absorbing it here keeps that its problem rather than ours.
            REPLY_STARTED: { actions: "announceReply" },
          },
        },
      },
    },
    /** The session died under us; reported exactly once, on the way in. */
    ended: {},
    /**
     * The client hung up.
     *
     * The teardown is NOT an entry action, for the reason the sibling states at
     * length: XState turns what an action throws into an actor error, so a
     * `ws.close()` that threw would stop propagating out of `stop()`.
     */
    closed: {
      on: { CLOSED: { actions: "logExpectedClose" } },
    },
  },
});

/** The transport's handle on its own lifecycle. */
export type OpenaiRealtimeLifecycle = {
  /** Where the connection is. */
  phase(): OpenaiRealtimePhase;
  /**
   * Is a reply in flight? The one query the send path needs, and it is a
   * position rather than a flag: false in every phase but `live.replying`.
   */
  replying(): boolean;
  /**
   * Should a socket-level error still be reported to the client?
   *
   * False in both terminal phases. `ended` has already reported the one fatal
   * error this session gets, and `closed` asked for the hang-up — a `ws` error
   * arriving after either is noise that would tear a client down twice, or once
   * for a call it ended itself.
   */
  reportsErrors(): boolean;
  send(event: OpenaiRealtimeLifecycleEvent): void;
};

/** Create the lifecycle for one OpenAI Realtime transport. */
export function createOpenaiRealtimeLifecycle(
  effects: OpenaiRealtimeLifecycleEffects,
): OpenaiRealtimeLifecycle {
  const actor = createActor(openaiRealtimeLifecycleMachine, { input: effects }).start();
  // Asked state by state rather than read off `value`, which is a bare string
  // for an atomic state and `{ live: "idle" }` for the compound one — narrowing
  // that union by hand would be a cast, and `matches` already knows the shape.
  const phase = (): OpenaiRealtimePhase => {
    const at = actor.getSnapshot();
    if (at.matches("connecting")) return "connecting";
    if (at.matches("ended")) return "ended";
    if (at.matches("closed")) return "closed";
    return "live";
  };
  return {
    phase,
    replying: () => actor.getSnapshot().matches({ live: "replying" }),
    reportsErrors: () => {
      const at = phase();
      return at !== "ended" && at !== "closed";
    },
    send: (event) => actor.send(event),
  };
}
