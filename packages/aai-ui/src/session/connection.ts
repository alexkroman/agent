// Copyright 2026 the AAI authors. MIT license.
/**
 * One browser session's CONNECTION — the socket, the handshake deadline over
 * it, and the server's idle retirement — as a statechart.
 *
 * `link` is `closed → open`, and `open` is `dialing → awaitingHandshake → live`:
 *
 * - **The socket belongs to `open`.** Its entry dials and attaches the
 *   listeners; its exit is the ONE teardown (detach, release the pre-connect
 *   mic, tear the audio path down, close the socket). A hang-up, a terminal
 *   close, an exhausted handshake and a fresh `connect()` all leave `open`, so
 *   none of them restates it, and exit actions run before the transition's, so
 *   the teardown always precedes the snapshot write reporting the end.
 * - **The handshake deadline is an `after` on `awaitingHandshake`** (see
 *   `session/handshake.ts` for why there is one). Leaving the state disarms it,
 *   so a `config` frame, a close or a teardown cannot leave it armed against
 *   the next attempt — there is no timer to clear by hand on abort.
 * - **partysocket owns the reconnect backoff.** A close that partysocket will
 *   retry goes back to `dialing` and waits for its next `open`; this machine
 *   never schedules an attempt. The deadline forces one only for a socket
 *   partysocket thinks is healthy (`forceReconnect`).
 *
 * `retired` is a second region because it outlives a socket: the server's
 * `session.timedOut` marks the close that follows as EXPECTED, so it is not
 * retried. Without it the automatic reconnect would re-open the session the
 * server just reclaimed — a tab left open would cycle forever and the guest
 * would never see zero sessions, which is the point of the timeout. Only a
 * fresh `connect()` (the user asking again) clears it.
 *
 * The machine owns WHEN; every HOW — the socket, the snapshot, the audio path —
 * is an injected {@link ConnectionEffects} call, as in `session/audio-state.ts`.
 */

import { and, assign, createActor, not, setup, stateIn } from "xstate";
import { closeFailure } from "./close.ts";
import { HANDSHAKE_TIMEOUT_MS, MAX_HANDSHAKE_TIMEOUTS } from "./handshake.ts";
import type { SessionConfigMessage } from "./messages.ts";

/** The socket shape the session speaks (a partysocket, or an injected `WebSocket`). */
type Socket = WebSocket;

/** The session core's side of the machine. */
export type ConnectionEffects = {
  /** Open the socket for a fresh `connect()` and make it the session's. */
  dial(): Socket;
  /**
   * Let go of everything one connection holds: the pre-connect mic, the audio
   * path and `socket`. Its listeners are already detached, so the close this
   * causes cannot re-enter the machine.
   */
  release(socket: Socket): void;
  /** The caller's `connect({ signal })` aborted: hang up. */
  abandon(): void;
  /** Interpret a frame; the `config` payload when it completes the handshake. */
  receive(data: unknown): SessionConfigMessage | undefined;
  /** The socket opened; the handshake has not completed yet. */
  opened(): void;
  /** The handshake completed. */
  configured(config: SessionConfigMessage): void;
  /** Is the session fatally over (`session/state.ts`)? Then no close is retried. */
  fatal(): boolean;
  /**
   * Will partysocket retry the close being dispatched on `socket`? Asked
   * inside the `close` listener: partysocket schedules its retry before it
   * dispatches.
   */
  retryPending(socket: Socket): boolean;
  /** Does the socket have reconnect machinery? An injected `WebSocket` does not. */
  canRedial(): boolean;
  /** Force a fresh attempt on a socket that opened but never became a session. */
  redial(): void;
  /** An attempt failed and another is coming: drop the audio path, show `connecting`. */
  retrying(): void;
  /** The socket closed for good — `failure` is what to report, null for a clean end. */
  closed(failure: string | null): void;
  /** The handshake budget is spent. */
  exhausted(): void;
};

/** Everything that happens to the connection. */
export type ConnectionEvent =
  /** `connect()`: tear down whatever is there and dial afresh. */
  | { type: "DIAL"; signal?: AbortSignal | undefined }
  /** The caller hung up (`disconnect()`, `end()`). */
  | { type: "HANG_UP" }
  /** The server retired the session for idleness (`session.timedOut`). */
  | { type: "RETIRED" }
  /** The socket opened. */
  | { type: "OPENED" }
  /** The `config` frame arrived. */
  | { type: "CONFIGURED"; config: SessionConfigMessage }
  /** The socket errored; a `close` always follows. */
  | { type: "ERRORED" }
  /** The socket closed; `reconnecting` is whether partysocket will retry it. */
  | { type: "DROPPED"; event: CloseEvent; reconnecting: boolean };

type Context = {
  effects: ConnectionEffects;
  link: Link;
  /**
   * CONSECUTIVE handshake timeouts. Only a completed handshake resets it: a
   * close must not, or a wedged peer that closes and reopens on its own is
   * re-dialled forever — the loop the budget exists to bound.
   */
  timeouts: number;
  /** The socket errored before this close — reported as a connection error. */
  errored: boolean;
};

/**
 * One `connect()`'s socket, from dial to teardown.
 *
 * Driven by `open`'s entry and exit actions rather than an invoke, because an
 * invoke's cleanup is DEFERRED past the transition's own actions: the teardown
 * has to run before the close it ends is reported, as it always has.
 */
type Link = {
  /** Dial, and route the socket's events (and `signal`'s abort) to the machine. */
  dial(signal: AbortSignal | undefined): void;
  /** Detach the listeners, then release what the connection holds. */
  teardown(): void;
};

/** What the machine is created with. */
type Input = { effects: ConnectionEffects; link: Link };

const connectionMachine = setup({
  types: {} as { context: Context; input: Input; events: ConnectionEvent },
  delays: { HANDSHAKE_TIMEOUT: HANDSHAKE_TIMEOUT_MS },
  guards: {
    /**
     * partysocket will retry this close, and nothing says it must not: a FATAL
     * error is not retryable by construction, nor is an idle retirement.
     */
    mayReconnect: and([
      ({ context, event }) =>
        event.type === "DROPPED" && event.reconnecting && !context.effects.fatal(),
      not(stateIn({ retired: "yes" })),
    ]),
    /** Budget left, and a socket that can re-dial at all. */
    mayRedial: ({ context }) =>
      context.timeouts + 1 < MAX_HANDSHAKE_TIMEOUTS && context.effects.canRedial(),
  },
  actions: {
    spend: assign({ timeouts: ({ context }) => context.timeouts + 1 }),
    /** A socket error inside a retry cycle is not terminal. */
    forgetError: assign({ errored: false }),
    retrying: ({ context }) => context.effects.retrying(),
    opened: ({ context }) => context.effects.opened(),
    dial: ({ context, event }) =>
      context.link.dial(event.type === "DIAL" ? event.signal : undefined),
    /** The ONE teardown: every way out of `open` runs it, before anything is reported. */
    teardown: ({ context }) => context.link.teardown(),
    reportClose: ({ context, event }) => {
      if (event.type === "DROPPED") {
        context.effects.closed(closeFailure(event.event, context.errored));
      }
    },
  },
}).createMachine({
  id: "connection",
  type: "parallel",
  context: ({ input }) => ({ ...input, timeouts: 0, errored: false }),
  states: {
    link: {
      initial: "closed",
      on: {
        // Re-entering `open` tears the old socket down (its exit) and dials a
        // new one (its entry), with a fresh budget.
        DIAL: { target: ".open", reenter: true },
        HANG_UP: ".closed",
      },
      states: {
        closed: {},
        open: {
          entry: [assign({ timeouts: 0, errored: false }), "dial"],
          exit: "teardown",
          initial: "dialing",
          on: {
            ERRORED: { actions: assign({ errored: true }) },
            CONFIGURED: {
              target: ".live",
              actions: [
                assign({ timeouts: 0 }),
                ({ context, event }) => context.effects.configured(event.config),
              ],
            },
            DROPPED: [
              // partysocket retries with backoff; the session stays logically
              // alive and the URL provider re-derives the resume URL.
              { guard: "mayReconnect", target: ".dialing", actions: ["forgetError", "retrying"] },
              // Terminal: an explicit close, retries exhausted, or a retry
              // declined. Leaving `open` cancels any still-scheduled retry.
              { target: "closed", actions: "reportClose" },
            ],
          },
          states: {
            dialing: {
              on: { OPENED: { target: "awaitingHandshake", actions: "opened" } },
            },
            awaitingHandshake: {
              on: { OPENED: { target: "awaitingHandshake", reenter: true, actions: "opened" } },
              after: {
                HANDSHAKE_TIMEOUT: [
                  {
                    guard: "mayRedial",
                    target: "dialing",
                    actions: ["spend", ({ context }) => context.effects.redial(), "retrying"],
                  },
                  {
                    target: "#connection.link.closed",
                    actions: ({ context }) => context.effects.exhausted(),
                  },
                ],
              },
            },
            live: {
              on: { OPENED: { target: "awaitingHandshake", actions: "opened" } },
            },
          },
        },
      },
    },
    retired: {
      initial: "no",
      states: {
        no: { on: { RETIRED: "yes" } },
        yes: { on: { DIAL: "no" } },
      },
    },
  },
});

/** Where the connection is. */
export type ConnectionPhase = "closed" | "dialing" | "awaitingHandshake" | "live";

/** The session core's handle on its connection. */
export type Connection = {
  /** Tear down whatever is there and dial afresh; `signal` aborting hangs up. */
  dial(signal?: AbortSignal): void;
  /** Hang up: the teardown, and no retry. */
  hangUp(): void;
  /** The server retired the session: the close that follows is not retried. */
  retire(): void;
  /** Where the connection is — for specs. */
  phase(): ConnectionPhase;
};

/** The socket half of {@link Link}: listeners in, teardown out. */
function createLink(effects: ConnectionEffects, send: (event: ConnectionEvent) => void): Link {
  let current: { socket: Socket; controller: AbortController } | null = null;
  return {
    dial(caller) {
      const controller = new AbortController();
      const { signal } = controller;
      caller?.addEventListener("abort", () => effects.abandon(), { signal });
      const socket = effects.dial();
      current = { socket, controller };
      socket.addEventListener("open", () => send({ type: "OPENED" }), { signal });
      socket.addEventListener(
        "message",
        (event: MessageEvent) => {
          const config = effects.receive(event.data);
          if (config) send({ type: "CONFIGURED", config });
        },
        { signal },
      );
      // Browsers fire "error" with no payload and always follow it with "close".
      socket.addEventListener("error", () => send({ type: "ERRORED" }), { signal });
      socket.addEventListener(
        "close",
        (event: CloseEvent) =>
          send({ type: "DROPPED", event, reconnecting: effects.retryPending(socket) }),
        { signal },
      );
    },
    teardown() {
      if (current === null) return;
      const { socket, controller } = current;
      current = null;
      // Detach first, so the close `release` causes cannot re-enter.
      controller.abort();
      effects.release(socket);
    },
  };
}

/** Create the connection machine for one browser session. */
export function createConnection(effects: ConnectionEffects): Connection {
  // The link reaches the actor only from socket events, which fire after it
  // exists (the machine starts `closed`, so nothing dials during `start()`).
  const link = createLink(effects, (event) => self.send(event));
  const self = createActor(connectionMachine, { input: { effects, link } }).start();
  return {
    dial: (signal) => {
      self.send({ type: "DIAL", signal });
    },
    hangUp: () => {
      self.send({ type: "HANG_UP" });
    },
    retire: () => {
      self.send({ type: "RETIRED" });
    },
    phase: () => {
      const at = self.getSnapshot().value.link;
      return typeof at === "string" ? "closed" : at.open;
    },
  };
}
