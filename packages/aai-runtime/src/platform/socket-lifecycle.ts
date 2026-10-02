// Copyright 2026 the AAI authors. MIT license.
/**
 * The platform socket's reconnect loop, as a statechart.
 *
 * A sibling of `transports/s2s-lifecycle.ts` and `session/ws-lifecycle.ts` —
 * read the first for the general argument. What was in `socket.ts` was a
 * NULLABLE HANDLE used as a phase plus four latches beside it: `socket |
 * undefined` (reassigned on every attempt), `closed`, `awaitingPong`,
 * `attempt`, and two restartable timers armed and cleared from six places.
 * Three `socket !== opening` checks dropped events from a socket an earlier
 * drop had already retired, and `!closed` was re-checked before every
 * reconnect.
 *
 * ## One socket is one invoked actor, which is what deletes the identity checks
 *
 * Each attempt dials inside a `fromCallback` actor invoked by `linked`. The
 * socket's four listeners only ever `sendBack`, and the actor's cleanup closes
 * it with 1001. Leaving `linked` — a close, an error, a missed pong, or
 * {@link PlatformSocketLifecycle.close} — stops that actor, and XState drops
 * whatever a stopped callback actor sends back. So the late `close` that
 * follows our own `close(1001)`, or a message `ws` had already buffered, is
 * discarded by the library rather than by an `if` somebody has to remember.
 * `ws` offers no `removeEventListener` on {@link HeaderWebSocket}, which is
 * why the drop has to happen at the actor boundary at all.
 *
 * ## Both timers are `after` delays
 *
 * The heartbeat is `idle`'s, the pong deadline `awaitingPong`'s and the
 * reconnect `backoff`'s; each is cancelled by leaving its state. The reconnect
 * delay is a function of the consecutive-failure count, which `backoff`'s entry
 * bumps before its delay is read (XState appends an `after`'s schedule to the
 * state's entry actions).
 *
 * **Effects stay in `socket.ts`.** The pending-call map, the id space, the
 * backoff curve and the logger are injected as {@link PlatformSocketLifecycleEffects};
 * this module decides WHEN to dial, ping, fail the calls in flight and give
 * up, and owns no call.
 */

import { assign, createActor, type EventObject, fromCallback, setup } from "xstate";
import type { HeaderWebSocket } from "../_ws.ts";
import {
  PlatformOutboundFrameSchema,
  type PlatformReplyFrame,
  parsePlatformFrame,
} from "./socket-frames.ts";

/** `ws`'s `OPEN`, spelled rather than imported — {@link HeaderWebSocket} is structural. */
const WS_OPEN = 1;

/** Where the platform socket is. */
export type PlatformSocketPhase = "connecting" | "open" | "backoff" | "closed";

/** The socket's side of the machine: everything the loop decides to do but does not know how to. */
export type PlatformSocketLifecycleEffects = {
  /** Dial one socket. May throw (a malformed URL, `ws` refusing the options). */
  dial(): HeaderWebSocket;
  /** Mint an id from the same space as call ids, for a ping. */
  nextId(): number;
  /** Settle the written call a reply answers. */
  settle(frame: PlatformReplyFrame): void;
  /** Give up on calls every caller has already given up on. Run on every heartbeat tick. */
  sweep(): void;
  /** Reject every written call — the socket under them is gone. */
  failInFlight(reason: string): void;
  /** The reconnect delay after `attempt` consecutive failures (1-based). */
  backoffMs(attempt: number): number;
  /** Structured log; the caller supplies `url`. */
  log(level: "debug" | "warn", message: string, fields?: Record<string, unknown>): void;
  /** How often to ping an open socket. */
  heartbeatMs: number;
  /** How long a pong may take before the socket is presumed dead. */
  pongDeadlineMs: number;
};

/** What one socket reports, already translated by its actor. */
type ConnectionEvent =
  | { type: "OPENED"; socket: HeaderWebSocket }
  | { type: "REPLY"; frame: PlatformReplyFrame }
  | { type: "PONG"; id: number }
  | { type: "CLOSED"; code: number | undefined }
  | { type: "ERRORED"; message: string | undefined }
  | { type: "DIAL_FAILED"; error: unknown };

type LifecycleEvent = ConnectionEvent | { type: "CLOSE" };

type Context = {
  effects: PlatformSocketLifecycleEffects;
  /** Consecutive failed attempts; zeroed by an open. */
  attempt: number;
  /** The socket, once it has opened. Only read in `linked.open`. */
  socket: HeaderWebSocket | undefined;
  /** The ping whose pong is outstanding. Only read in `awaitingPong`. */
  pingId: number | undefined;
};

/**
 * One attempt: dial, translate the socket's events, close it on stop.
 *
 * Every listener `sendBack`s and does nothing else, so an event from a socket
 * whose attempt is over is dropped by XState (a stopped callback actor's
 * `sendBack` is a no-op) — the job `socket !== opening` used to do.
 */
const connection = fromCallback<EventObject, PlatformSocketLifecycleEffects>(
  ({ input, sendBack }) => {
    const send = (event: ConnectionEvent): void => sendBack(event);
    let socket: HeaderWebSocket;
    try {
      socket = input.dial();
    } catch (error: unknown) {
      send({ type: "DIAL_FAILED", error });
      return;
    }
    socket.addEventListener("open", () => send({ type: "OPENED", socket }));
    socket.addEventListener("message", (event) => {
      const text = typeof event.data === "string" ? event.data : String(event.data);
      const frame = parsePlatformFrame(PlatformOutboundFrameSchema, text);
      if (frame === undefined) {
        // Forwards compatibility, not leniency: a frame this build does not know is
        // how a newer platform would add one. See `parsePlatformFrame`.
        input.log("debug", "platform socket dropped an unreadable frame");
        return;
      }
      send(frame.t === "pong" ? { type: "PONG", id: frame.id } : { type: "REPLY", frame });
    });
    socket.addEventListener("close", (event) => send({ type: "CLOSED", code: event.code }));
    socket.addEventListener("error", (event) => send({ type: "ERRORED", message: event.message }));
    return () => {
      // 1001 "going away": this end is the one giving up, and a statusless close is
      // reported by both peers as 1005, which is indistinguishable from the socket
      // simply vanishing (see `HeaderWebSocket.close`).
      try {
        socket.close(1001);
      } catch {
        // Already gone. There is nothing a close can add.
      }
    };
  },
);

const platformSocketLifecycleMachine = setup({
  types: {} as { context: Context; input: PlatformSocketLifecycleEffects; events: LifecycleEvent },
  actors: { connection },
  delays: {
    heartbeat: ({ context }) => context.effects.heartbeatMs,
    pongDeadline: ({ context }) => context.effects.pongDeadlineMs,
    reconnect: ({ context }) => context.effects.backoffMs(context.attempt),
  },
  guards: {
    socketOpen: ({ context }) => context.socket?.readyState === WS_OPEN,
    isOutstandingPong: ({ context, event }) => event.type === "PONG" && event.id === context.pingId,
  },
  actions: {
    sweep: ({ context }) => context.effects.sweep(),
    settle: ({ context, event }) => {
      if (event.type === "REPLY") context.effects.settle(event.frame);
    },
    adoptSocket: assign({
      attempt: 0,
      socket: ({ context, event }) => (event.type === "OPENED" ? event.socket : context.socket),
    }),
    forgetSocket: assign({ socket: undefined, pingId: undefined }),
    countAttempt: assign({ attempt: ({ context }) => context.attempt + 1 }),
    mintPing: assign({ pingId: ({ context }) => context.effects.nextId() }),
    sendPing: ({ context }) => {
      try {
        context.socket?.send(JSON.stringify({ t: "ping", id: context.pingId }));
      } catch {
        // A write the OS refused. The pong deadline below is what decides, the
        // same as for a ping the peer never answered — and a throw here would
        // stop the actor, ending reconnects for the life of the process.
      }
    },
    failInFlight: ({ context }: { context: Context }, params: { reason: string }) =>
      context.effects.failInFlight(params.reason),
  },
}).createMachine({
  id: "platformSocketLifecycle",
  context: ({ input }) => ({ effects: input, attempt: 0, socket: undefined, pingId: undefined }),
  initial: "linked",
  states: {
    /** One attempt's socket exists, opening or open. Leaving stops its actor and closes it. */
    linked: {
      invoke: { src: "connection", input: ({ context }) => context.effects },
      exit: "forgetSocket",
      initial: "connecting",
      on: {
        // Accepted from the moment the socket exists, as before: the platform
        // answers nothing before `open`, so this is a description, not a case.
        REPLY: { actions: "settle" },
        DIAL_FAILED: {
          target: "backoff",
          actions: ({ context, event }) =>
            context.effects.log("warn", "platform socket could not be created", {
              error: String(event.error),
            }),
        },
        CLOSED: {
          target: "backoff",
          actions: [
            // Every close is worth a line and none is worth a warn on its own: the
            // platform retires a replica on every deploy, so a closed socket is
            // ordinary and only a call failing on it is news (the caller logs that).
            ({ context, event }) =>
              context.effects.log("debug", "platform socket closed", { code: event.code }),
            {
              type: "failInFlight",
              params: ({ event }) => ({ reason: `closed (${event.code ?? "no code"})` }),
            },
          ],
        },
        ERRORED: {
          target: "backoff",
          actions: [
            // A handshake refusal lands here — a platform without the route answers
            // 404, an unauthorized guest 401 — and so does a transport fault. It is
            // a WARN because a socket that never opens means every call is silently
            // on HTTP, which is exactly the state that is otherwise invisible.
            ({ context, event }) =>
              context.effects.log("warn", "platform socket error", {
                error: event.message ?? "unknown",
              }),
            { type: "failInFlight", params: { reason: "errored" } },
          ],
        },
        CLOSE: {
          target: "closed",
          actions: { type: "failInFlight", params: { reason: "closed by this process" } },
        },
      },
      states: {
        connecting: {
          on: {
            OPENED: {
              target: "open",
              actions: [
                "adoptSocket",
                ({ context }) => context.effects.log("debug", "platform socket open"),
              ],
            },
          },
        },
        open: {
          initial: "idle",
          states: {
            /** Healthy; the next ping is a heartbeat away. */
            idle: {
              after: {
                heartbeat: [
                  { guard: "socketOpen", target: "awaitingPong", actions: "sweep" },
                  // Not open (closing under us): its `close` is on its way, so keep
                  // the heartbeat running rather than pinging a dying socket.
                  { target: "idle", reenter: true, actions: "sweep" },
                ],
              },
            },
            /** A ping is on the wire and its pong is not back. */
            awaitingPong: {
              entry: ["mintPing", "sendPing"],
              on: { PONG: { guard: "isOutstandingPong", target: "idle" } },
              after: {
                pongDeadline: {
                  target: "#platformSocketLifecycle.backoff",
                  actions: [
                    "sweep",
                    // A pong that never came. The socket reads as open and answers
                    // nothing, which is the one failure mode a deadline per call
                    // cannot distinguish from a slow platform — see `socket.ts`.
                    ({ context }) =>
                      context.effects.log("warn", "platform socket heartbeat timed out", {
                        waitedMs: context.effects.pongDeadlineMs,
                      }),
                    { type: "failInFlight", params: { reason: "heartbeat timed out" } },
                  ],
                },
              },
            },
          },
        },
      },
    },
    /** Waiting out a jittered delay before the next attempt. */
    backoff: {
      entry: "countAttempt",
      after: { reconnect: { target: "linked" } },
      on: { CLOSE: { target: "closed" } },
    },
    /**
     * Stopped by this process. No timer is scheduled and no socket is live.
     *
     * Not `type: "final"`, for the reason `ws-lifecycle.ts`'s `ended` gives: a
     * second `close()` is an unhandled event in a live actor, which is silent,
     * where a send to a stopped one warns.
     */
    closed: {},
  },
});

/** The platform socket's handle on its own reconnect loop. */
export type PlatformSocketLifecycle = {
  /** Where the loop is. */
  phase(): PlatformSocketPhase;
  /** The socket that has opened, in `open` only. Its `readyState` is the caller's to read. */
  openSocket(): HeaderWebSocket | undefined;
  /** Stop reconnecting and drop the socket. Idempotent. */
  close(): void;
};

/** Start the loop: it dials immediately and reconnects until {@link PlatformSocketLifecycle.close}d. */
export function createPlatformSocketLifecycle(
  effects: PlatformSocketLifecycleEffects,
): PlatformSocketLifecycle {
  const actor = createActor(platformSocketLifecycleMachine, { input: effects }).start();
  const phase = (): PlatformSocketPhase => {
    const at = actor.getSnapshot();
    if (at.matches({ linked: "connecting" })) return "connecting";
    if (at.matches({ linked: "open" })) return "open";
    if (at.matches("backoff")) return "backoff";
    return "closed";
  };
  return {
    phase,
    openSocket: () => (phase() === "open" ? actor.getSnapshot().context.socket : undefined),
    close: () => actor.send({ type: "CLOSE" }),
  };
}
