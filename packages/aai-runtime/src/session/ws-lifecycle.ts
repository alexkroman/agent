// Copyright 2026 the AAI authors. MIT license.
/**
 * One client socket's session lifecycle, as a statechart.
 *
 * The third of these, after `transports/s2s-lifecycle.ts` and
 * `transports/openai-realtime-lifecycle.ts` — read the first for the general
 * argument. What was here was not a set of latches but something worse: a
 * NULLABLE RESOURCE HANDLE used as a phase.
 *
 * `session: ServerSession | null` meant three different things depending on where
 * you read it — "not created yet", "the close handler already cleaned up", and
 * "start() failed and cleaned up" — and the code said so out loud, in a comment
 * that had to explain which one a particular `if (session)` was testing before
 * it could explain what the branch did. Beside it sat `sessionReady`, and
 * `messageBuffer`, whose `!== null` was the same fact as `!sessionReady`
 * written a second way. Three variables, four phases, and no two of them
 * agreeing on how to spell one.
 *
 * ## `start()` is an INVOKE, which is what deletes the staleness guard
 *
 * The continuation opened with the shape the S2S module was written to remove:
 *
 * ```ts no-check
 * // Socket closed while start() was in flight — the session is already
 * // stopped and the buffer discarded; don't mark it ready.
 * if (!session) return;
 * ```
 *
 * As an invoked actor of `starting`, a close LEAVES that state and stops the
 * actor, so neither its resolution nor its rejection is delivered — the guard
 * is the machine rather than a re-check somebody has to remember. The same
 * applies to the rejection arm, which had to re-derive whether the close
 * handler had already run before deciding whether to clean up twice.
 *
 * Note the actor wraps whatever the transport hands it: the session-start
 * DEADLINE stays a `p-timeout` at the call site, because a rejection is exactly
 * what this state is prepared for and xstate has no timeout of its own worth
 * substituting for one.
 *
 * ## The buffer is dropped by LEAVING, and drained by ARRIVING
 *
 * Pre-ready frames used to be discarded at three call sites (`start()`'s
 * rejection, the close handler, and the drain itself) by assigning
 * `messageBuffer = null`, each of which also had to decide whether it was the
 * one that got there first. The drain is `ready`'s entry, so the only way
 * frames are replayed is by the session becoming ready, and the discard is
 * `ended`'s — one place, covering every way a session can end without one.
 *
 * The buffer itself stays in the handler's closure, like the socket in the two
 * sibling machines: this module decides WHEN, and the accounting a byte budget
 * needs is not a decision.
 */

import { createActor, fromPromise, setup } from "xstate";

/** Where one client socket's session is. */
export type WsSessionPhase = "connecting" | "starting" | "ready" | "ended";

/**
 * The handler's side of the machine: everything the lifecycle decides to do but
 * does not know how to.
 */
export type WsSessionLifecycleEffects = {
  /**
   * Run `session.start()` under whatever deadline the handler applies.
   *
   * Invoked on entry to `starting` and STOPPED by leaving it, which is the
   * whole reason it is an actor rather than a fire-and-forget promise. Note
   * stopping the actor does not cancel the underlying `start()` — `p-timeout`
   * says the same of its own rejection — so `endSession` still has to tear the
   * session down on the paths that leave early.
   */
  start(): Promise<void>;
  /** Announce a session that reached ready, fault code and all. */
  announceReady(): void;
  /** Replay the frames that arrived before the session was ready. */
  drainBuffer(): void;
  /** Discard them unreplayed. The entry action of `ended`. */
  dropBuffer(): void;
  /** Stop the session and run end-of-session cleanup, exactly once. */
  endSession(): void;
  /**
   * Tell the client its session died, and close the socket.
   *
   * Separate from {@link WsSessionLifecycleEffects.endSession} because the
   * order matters and used to be spelled out at the call site: tear the session
   * down first, then tell the client — it has already received `config` and
   * believes the session is live.
   */
  failClient(): void;
};

/** Everything that happens to one client socket's session. */
export type WsSessionLifecycleEvent =
  /** The session object exists, is claimed, and has been configured. */
  | { type: "CREATED" }
  /** `createSession` threw; there is nothing to stop. */
  | { type: "CREATE_FAILED" }
  /** The client socket closed. */
  | { type: "SOCKET_CLOSED" };

type Context = { effects: WsSessionLifecycleEffects };

const wsSessionLifecycleMachine = setup({
  types: {} as {
    context: Context;
    input: WsSessionLifecycleEffects;
    events: WsSessionLifecycleEvent;
  },
  actors: {
    startSession: fromPromise(({ input }: { input: WsSessionLifecycleEffects }) => input.start()),
  },
  actions: {
    announceReady: ({ context }) => context.effects.announceReady(),
    drainBuffer: ({ context }) => context.effects.drainBuffer(),
    dropBuffer: ({ context }) => context.effects.dropBuffer(),
    endSession: ({ context }) => context.effects.endSession(),
    failClient: ({ context }) => context.effects.failClient(),
  },
}).createMachine({
  id: "wsSessionLifecycle",
  context: ({ input }) => ({ effects: input }),
  initial: "connecting",
  states: {
    /** The socket is open (or opening) and no session exists yet. */
    connecting: {
      on: {
        CREATED: { target: "starting" },
        // Both end the socket's session with nothing to tear down: a session
        // that was never built, and one the client abandoned before it was.
        CREATE_FAILED: { target: "ended" },
        SOCKET_CLOSED: { target: "ended" },
      },
    },
    /**
     * `start()` is in flight. Inbound frames are buffered rather than dispatched
     * into a session whose transport has not connected.
     */
    starting: {
      invoke: {
        src: "startSession",
        input: ({ context }) => context.effects,
        onDone: { target: "ready", actions: "announceReady" },
        onError: {
          target: "ended",
          // Ordered: tear the session down, then tell the client. That is what
          // stops a `p-timeout` rejection leaving a live provider socket
          // behind — the rejection does NOT cancel the `start()` underneath it.
          //
          // The failure is LOGGED by the effect rather than here, and that is a
          // real distinction: a start that fails after the client hung up has
          // left this state, so `onError` never fires, and the line is the only
          // evidence a provider connect black-holed.
          actions: ["endSession", "failClient"],
        },
      },
      on: { SOCKET_CLOSED: { target: "ended", actions: "endSession" } },
    },
    /** A live session. Frames go straight through. */
    ready: {
      entry: "drainBuffer",
      on: { SOCKET_CLOSED: { target: "ended", actions: "endSession" } },
    },
    /**
     * Over, however it got here.
     *
     * Its entry DISCARDS whatever is still buffered, and that placement is
     * load-bearing rather than a preference: XState runs a source state's exit
     * actions before the target's entry ones, so a `dropBuffer` on `starting`'s
     * exit emptied the buffer a moment before `ready`'s entry could drain it —
     * every pre-ready frame silently lost, caught by four specs. "Discarded
     * when the session ends" is the same rule stated where the ordering works,
     * and it is one place rather than one per losing transition.
     *
     * A trailing `SOCKET_CLOSED` — the close that follows a failed `start()`,
     * or a second one from a test double — is unhandled here, which is what
     * replaces the `session === null` re-check that used to keep `endSession`
     * from running twice.
     *
     * Deliberately NOT `type: "final"`, which was the first draft. Leaving
     * `starting` already stops the invoked `start()` — an invocation's lifetime
     * is its state's — so `final` bought nothing, and xstate WARNS on a send to
     * a stopped actor ("has already reached its final state"). That put a
     * stderr line on an ordinary path, since a failed start is followed by the
     * socket's own close. An unhandled event in a live actor is silent.
     */
    ended: { entry: "dropBuffer" },
  },
});

/** The handler's handle on its own session lifecycle. */
export type WsSessionLifecycle = {
  /** Where the session is. */
  phase(): WsSessionPhase;
  /**
   * Should an inbound frame be BUFFERED rather than dispatched?
   *
   * True only in `starting`. The complement is not "dispatch" — see
   * {@link WsSessionLifecycle.dispatches}, since `connecting` and `ended` drop.
   */
  buffering(): boolean;
  /** Should an inbound frame be dispatched into the session? `ready` only. */
  dispatches(): boolean;
  send(event: WsSessionLifecycleEvent): void;
};

/** Create the lifecycle for one client socket. */
export function createWsSessionLifecycle(effects: WsSessionLifecycleEffects): WsSessionLifecycle {
  const actor = createActor(wsSessionLifecycleMachine, { input: effects }).start();
  const phase = (): WsSessionPhase => {
    const at = actor.getSnapshot();
    if (at.matches("connecting")) return "connecting";
    if (at.matches("starting")) return "starting";
    if (at.matches("ready")) return "ready";
    return "ended";
  };
  return {
    phase,
    buffering: () => phase() === "starting",
    dispatches: () => phase() === "ready",
    send: (event) => actor.send(event),
  };
}
