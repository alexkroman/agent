// Copyright 2026 the AAI authors. MIT license.
/**
 * The AssemblyAI streaming TTS socket's lifecycle across a barge-in, as a
 * statechart: the `Cancel` frame, the window in which the abandoned turn's
 * trailing frames must be ignored, and the reconnect that is the fallback when
 * a socket cannot carry that frame or will not answer it.
 *
 * Split out for the same reason `assemblyai-segment.ts` and
 * `assemblyai-turn.ts` are — the adapter owns the socket and the turn, this
 * owns WHEN the socket is replaced. Read `transports/s2s-lifecycle.ts` for the
 * general argument; what this replaced was the same shape it describes:
 *
 * - `queued: Frame[] | null` was the phase "a replacement is connecting",
 *   spelled as a nullable buffer, assigned at four call sites.
 * - A cancel barrier held a `pending` count and a nullable `timer`, and its
 *   deadline callback had to re-ask whether the session was still open.
 * - The replacement's `waitForOpen` was fire-and-forget, so both of its arms
 *   opened with `if (shell.isClosed() || ws !== next) return` — an identity
 *   check standing in for "is this still the reconnect that matters". As an
 *   invoke of `reconnecting`, leaving the state stops it (and aborts the wait
 *   through its signal), so that guard is the machine rather than a re-check.
 *
 * ```text
 * open        ── CANCEL, socket open ──▶ cancelling
 * cancelling  ── CANCEL, socket open ──▶ cancelling   (one more to answer; re-armed)
 * cancelling  ── the last CANCELLED ───▶ open
 * cancelling  ── after ACK_TIMEOUT ────▶ reconnecting
 * open | cancelling | failed ── CANCEL, socket shut ──▶ reconnecting
 * reconnecting ── opened ──▶ open        reconnecting ── rejected ──▶ failed
 * (any)       ── CLOSE ────────────────▶ closed
 * ```
 *
 * **Effects stay in the adapter.** The machine holds no socket and no frame:
 * the live socket, the frames queued for a replacement and the turn tracker
 * are the adapter's closure, and every HOW arrives as an injected
 * {@link AssemblyAITtsLifecycleEffects} call.
 *
 * ## A mid-turn cancel sends `Cancel` and KEEPS the socket
 *
 * The adapter's module doc asserted the opposite for a long time — "the
 * protocol has no discard/cancel frame, so a mid-turn cancel drops the whole
 * connection and reconnects" — which was never verified and is wrong; `Cancel`
 * is in the vocabulary the service enumerates when handed an unknown frame
 * type. So every barge-in was tearing down and rebuilding a WebSocket, paying a
 * reconnect at the one moment in a call when the caller is actively talking.
 *
 * Both properties the reconnect existed for are things `Cancel` does, measured
 * against production 2026-08-18:
 *
 * - **It discards text Generate'd but never Flush'ed**, which would otherwise
 *   be spliced into the next turn's synthesis. `Generate(~40s of text)` ->
 *   `Cancel` -> `Generate("Here is the second turn.")` + `Flush` synthesized
 *   1600 ms of audio, against a 1520 ms baseline for that sentence alone.
 * - **It aborts synthesis already in progress.** Cancelling 120 ms into a
 *   ~40 s reply delivered ~2.5 s of audio in total, and the turn was answered
 *   with `Cancelled` and no `FlushDone` at all.
 *
 * ## `Cancelled` is the BOUNDARY, and `cancelling` is the window it closes
 *
 * Dropping the connection made the abandoned turn's late frames unobservable
 * for free. On a socket that survives, ~0.3 s of already-in-flight audio still
 * arrives after the `Cancel` goes out, and a stale `is_final`/`FlushDone` would
 * retire one of the NEXT turn's outstanding flushes — the hazard
 * `assemblyai-turn.ts` describes. The service answers in order on one socket,
 * so its `Cancelled` frame is exactly the line between the two turns:
 * everything before it belongs to the turn the caller barged in on. Verified
 * end-to-end against production, the adapter leaks **0 bytes** after a cancel
 * where the raw socket delivers ~0.3 s.
 *
 * The window is a COUNT, not a flag: a second barge-in can land while the
 * first is still unacknowledged, and the window has to stay shut until the last
 * is answered. A stray `Cancelled` outside the window changes nothing.
 *
 * `Error` is deliberately NOT suppressed in that window — it describes the
 * SOCKET, not the abandoned turn, and swallowing one would mute the session
 * silently. That filtering is applied by the frame handler
 * (`assemblyai-frames.ts`); this module owns only the window.
 *
 * ## The deadline is why the reconnect survives
 *
 * A window that never lifts is a session that never plays audio again — the
 * same silent-mute failure the reconnect's own deadline exists to prevent,
 * reached by a new route — so a `Cancelled` that does not arrive within
 * {@link TTS_CANCEL_ACK_TIMEOUT_MS} falls back to replacing the socket. A
 * second `Cancel` re-arms it from its own send. Measured, that acknowledgement
 * lands within a millisecond; the deadline is a liveness bound on a misbehaving
 * socket, not a tuning knob.
 *
 * ## `failed` is not terminal
 *
 * A replacement that never opens is reported once and released, which leaves
 * the session holding a dead socket: every send is refused, exactly as it was
 * before this module existed. The next barge-in finds that socket shut and
 * tries a replacement again, so `failed` answers `CANCEL` the way `open` does.
 *
 * A server-side close is NOT an event here: the adapter releases the turn and
 * reports it, and the socket simply stops being open — which is what the next
 * `CANCEL`'s guard reads.
 */

import { TTS_CANCEL_ACK_TIMEOUT_MS } from "@alexkroman1/aai/host-internal";
import { assign, createActor, fromPromise, setup } from "xstate";

/** Where the adapter's socket is. */
export type AssemblyAITtsPhase = "open" | "cancelling" | "reconnecting" | "failed" | "closed";

/**
 * The adapter's side of the machine: everything the lifecycle decides to do but
 * does not know how to.
 */
export type AssemblyAITtsLifecycleEffects = {
  /**
   * Can the live socket carry a frame right now? The `Cancel` guard: a socket
   * that cannot carry one is what the reconnect is for.
   */
  socketOpen(): boolean;
  /** Send `Cancel` on the live socket. */
  sendCancel(): void;
  /**
   * Drop the live socket, forget the flushes it owed, and connect a
   * replacement; resolve once it opens, reject if it cannot be built or does
   * not open in time.
   *
   * Invoked on entry to `reconnecting` and STOPPED by leaving it — `signal`
   * aborts then, so a superseded wait releases its listener and deadline.
   */
  replaceSocket(signal: AbortSignal): Promise<void>;
  /** The replacement opened: attach it, then send what queued for it, in order. */
  adoptSocket(): void;
  /** Discard the frames queued for a replacement still connecting. */
  dropQueue(): void;
  /** The replacement never opened: release it and report, once. */
  reconnectFailed(cause: unknown): void;
};

/** Everything that happens to the adapter's socket. */
export type AssemblyAITtsLifecycleEvent =
  /** A barge-in cancelled a turn that was in flight. */
  | { type: "CANCEL" }
  /** The service acknowledged one `Cancel`. */
  | { type: "CANCELLED" }
  /** The session closed. */
  | { type: "CLOSE" };

type Context = {
  effects: AssemblyAITtsLifecycleEffects;
  /** `Cancel` frames sent and not yet answered. Read in `cancelling` only. */
  pendingCancels: number;
};

/**
 * `CANCEL` from a state whose socket might carry the frame: send it and shut
 * the window, or — on a socket that cannot — replace the socket. The cancelled
 * turn's frames die with it, so the window needs no shutting then.
 */
const cancelFrom = (count: "firstCancel" | "anotherCancel") =>
  [
    {
      guard: "socketOpen",
      target: "cancelling",
      // Re-entered from `cancelling` itself, which is what re-arms the deadline
      // from the second `Cancel`'s own send.
      reenter: true,
      actions: ["sendCancel", count],
    },
    { target: "reconnecting" },
  ] as const;

const assemblyAITtsLifecycleMachine = setup({
  types: {} as {
    context: Context;
    input: AssemblyAITtsLifecycleEffects;
    events: AssemblyAITtsLifecycleEvent;
  },
  actors: {
    replaceSocket: fromPromise(
      ({ input, signal }: { input: AssemblyAITtsLifecycleEffects; signal: AbortSignal }) =>
        input.replaceSocket(signal),
    ),
  },
  guards: {
    socketOpen: ({ context }) => context.effects.socketOpen(),
    lastCancel: ({ context }) => context.pendingCancels <= 1,
  },
  actions: {
    sendCancel: ({ context }) => context.effects.sendCancel(),
    firstCancel: assign({ pendingCancels: 1 }),
    anotherCancel: assign({ pendingCancels: ({ context }) => context.pendingCancels + 1 }),
    cancelAnswered: assign({ pendingCancels: ({ context }) => context.pendingCancels - 1 }),
    adoptSocket: ({ context }) => context.effects.adoptSocket(),
    dropQueue: ({ context }) => context.effects.dropQueue(),
  },
  delays: { ACK_TIMEOUT: TTS_CANCEL_ACK_TIMEOUT_MS },
}).createMachine({
  id: "assemblyAITtsLifecycle",
  context: ({ input }) => ({ effects: input, pendingCancels: 0 }),
  initial: "open",
  // Root-level: closing is a fact about the session rather than any one
  // position in the socket's life. It stops the deadline and any reconnect.
  on: { CLOSE: { target: ".closed" } },
  states: {
    /** The socket carries frames and every frame it delivers is heard. */
    open: { on: { CANCEL: cancelFrom("firstCancel") } },
    /**
     * `Cancel` went out and is unanswered: the abandoned turn's trailing frames
     * are still arriving, and none of them may reach the session.
     */
    cancelling: {
      after: { ACK_TIMEOUT: { target: "reconnecting" } },
      on: {
        CANCEL: cancelFrom("anotherCancel"),
        CANCELLED: [{ guard: "lastCancel", target: "open" }, { actions: "cancelAnswered" }],
      },
    },
    /**
     * A replacement socket is connecting. Frames queue in the adapter and are
     * flushed to it on open, preserving order.
     */
    reconnecting: {
      invoke: {
        src: "replaceSocket",
        input: ({ context }) => context.effects,
        onDone: { target: "open", actions: "adoptSocket" },
        onError: {
          target: "failed",
          actions: [
            "dropQueue",
            ({ context, event }) => context.effects.reconnectFailed(event.error),
          ],
        },
      },
      on: {
        // The cancelled turn's frames never left the process — dropping them
        // IS the cancel.
        CANCEL: { actions: "dropQueue" },
      },
    },
    /** The replacement never opened. See the module doc: not terminal. */
    failed: { on: { CANCEL: cancelFrom("firstCancel") } },
    /**
     * The session is over. Deliberately not `type: "final"` — a trailing
     * `CANCELLED` from a socket's buffered frames would make xstate warn about
     * a send to a stopped actor (see `session/ws-lifecycle.ts`).
     */
    closed: {},
  },
});

/** The adapter's handle on its own socket lifecycle. */
export type AssemblyAITtsLifecycle = {
  /** Where the socket is. */
  phase(): AssemblyAITtsPhase;
  /** Is a cancelled turn's audio still arriving? True in `cancelling` only. */
  abandoned(): boolean;
  /**
   * Should an outgoing frame be QUEUED for a replacement socket rather than
   * written to the live one? True in `reconnecting` only.
   */
  queueing(): boolean;
  send(event: AssemblyAITtsLifecycleEvent): void;
};

/**
 * Unref'd, so an armed acknowledgement deadline never holds the process open.
 * The globals are read per call, which is what lets fake timers reach them.
 */
const unrefClock = {
  setTimeout: (fn: (...args: unknown[]) => void, ms: number): ReturnType<typeof setTimeout> => {
    const timer = globalThis.setTimeout(fn, ms);
    timer.unref?.();
    return timer;
  },
  clearTimeout: (timer: ReturnType<typeof setTimeout>): void => globalThis.clearTimeout(timer),
};

/** Create the socket lifecycle for one AssemblyAI TTS session. */
export function createAssemblyAITtsLifecycle(
  effects: AssemblyAITtsLifecycleEffects,
): AssemblyAITtsLifecycle {
  const actor = createActor(assemblyAITtsLifecycleMachine, {
    input: effects,
    clock: unrefClock,
  }).start();
  const phase = (): AssemblyAITtsPhase => actor.getSnapshot().value;
  return {
    phase,
    abandoned: () => phase() === "cancelling",
    queueing: () => phase() === "reconnecting",
    send: (event) => actor.send(event),
  };
}
