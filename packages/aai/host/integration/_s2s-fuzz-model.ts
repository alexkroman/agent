// Copyright 2026 the AAI authors. MIT license.
/**
 * The fake AssemblyAI S2S link for the S2S property test
 * (`s2s-fuzz.integration.test.ts`): a scriptable WebSocket, and the ledgers its
 * oracles read.
 *
 * The property drives the REAL stack — `connectS2s` (wire parse + dispatch)
 * under `createS2sTransport` (resume, tool-result redelivery, audio
 * suppression) under `createSessionCore` (turn lifecycle, tool execution) — so
 * the only fake in the path is the socket. That is deliberate: the two bugs it
 * found live in the SEAMS between those layers (see the spec's module doc), and
 * a spec that stubs a layer out cannot see them.
 *
 * **Nothing here uses a timer.** A socket opens when a command opens it and
 * closes when a command drops it, because fast-check's shrinking and seed replay
 * are only worth anything if a run is reproducible: the hand-rolled walk this
 * replaced awaited real `setTimeout`s, so the same seed interleaved differently
 * run to run and a counterexample could not be re-run. The one concession is
 * that `close()` dispatches its event on a microtask, which `ws` also does —
 * a synchronous dispatch would hide reentrancy the real socket exposes.
 *
 * @internal Test infrastructure, not part of any public API.
 */

import type { CreateS2sWebSocket, S2sWebSocket } from "../s2s.ts";

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

/** Close codes the transport treats as worth a `session.resume`. */
export const TRANSIENT_CODES = [1005, 1006, 1011, 3005] as const;
/** Close codes that retire the session outright. */
export const FATAL_CODES = [1008, 4001] as const;

/** One tool call the service issued, and what came back for it. */
export interface CallRecord {
  callId: string;
  /** Socket it was issued on. */
  socketId: number;
  /** The reply that issued it — results flush per REPLY, as a batch. */
  replyId: string;
  /** How the reply that issued it ended, if it has. */
  replyEnded: "completed" | "interrupted" | null;
  /** `tool.result` frames seen for it, on any socket. */
  answers: number;
  /** A later socket successfully resumed the session that issued it. */
  survivedResume: boolean;
}

/** The fake socket, doubling as the test-side handle for it. */
export type FakeS2sSocket = S2sWebSocket & {
  readonly id: number;
  readyState: number;
  /** Frames the code under test sent, parsed. */
  readonly sent: Record<string, unknown>[];
  /** Frames it tried to send while the socket was not OPEN — always a bug. */
  readonly sentWhileNotOpen: string[];
  /** `close()` was called on it by the code under test. */
  closedByCode: boolean;
  /** Its `close` event has been dispatched. */
  dead: boolean;
  /** The session id a `session.resume` on this socket asked for, if any. */
  resumeRequested: string | null;
  /** The session id this socket's handshake answered with, if it has. */
  sessionId: string | null;
  open(): void;
  deliverRaw(data: string): void;
  deliver(frame: Record<string, unknown>): void;
  /** Provider-side close (a drop, not our teardown). */
  drop(code: number, reason?: string): void;
  socketError(message: string): void;
};

interface LinkState {
  sockets: FakeS2sSocket[];
  issuedSessionIds: Set<string>;
  calls: Map<string, CallRecord>;
  resumeRequests: string[];
}

/** The fake link: a socket factory plus the ledgers the oracles read. */
export interface FakeS2sLink {
  createWebSocket: CreateS2sWebSocket;
  readonly sockets: FakeS2sSocket[];
  readonly issuedSessionIds: Set<string>;
  readonly calls: Map<string, CallRecord>;
  /** Session ids `session.resume` was sent for, in order. */
  readonly resumeRequests: string[];
  /** The socket the code most recently opened — the live one. */
  current(): FakeS2sSocket | undefined;
  /** A socket that exists but has not completed its handshake, if any. */
  unopened(): FakeS2sSocket | undefined;
  /** Record a `tool.call` the service just issued. */
  noteCall(callId: string, socketId: number, replyId: string): void;
  /** Record how the reply carrying `callIds` ended. */
  endReply(status: "completed" | "interrupted", callIds: Iterable<string>): void;
  /** Mark calls as having been carried across a successful resume. */
  markSurvivedResume(callIds: Iterable<string>): void;
}

/**
 * Record what the code under test just sent. `tool.result` and `session.resume`
 * are the two frames the oracles care about; the rest are kept so the spec can
 * assert on shape (one handshake per socket, never both kinds).
 */
function noteOutbound(state: LinkState, sock: FakeS2sSocket, frame: Record<string, unknown>): void {
  if (frame.type === "tool.result" && typeof frame.call_id === "string") {
    const record = state.calls.get(frame.call_id);
    if (record !== undefined) record.answers++;
  }
  if (frame.type === "session.resume" && typeof frame.session_id === "string") {
    state.resumeRequests.push(frame.session_id);
    sock.resumeRequested = frame.session_id;
  }
}

function makeSocket(id: number, state: LinkState): FakeS2sSocket {
  const target = new EventTarget();
  const sock = Object.assign(target, {
    id,
    readyState: CONNECTING,
    bufferedAmount: 0,
    sent: [] as Record<string, unknown>[],
    sentWhileNotOpen: [] as string[],
    closedByCode: false,
    dead: false,
    resumeRequested: null as string | null,
    sessionId: null as string | null,

    send(data: string): void {
      if (sock.readyState !== OPEN) {
        sock.sentWhileNotOpen.push(data);
        return;
      }
      const parsed = JSON.parse(data) as Record<string, unknown>;
      sock.sent.push(parsed);
      noteOutbound(state, sock, parsed);
    },

    close(code?: number): void {
      sock.closedByCode = true;
      if (sock.dead) return;
      sock.readyState = CLOSING;
      queueMicrotask(() => emitClose(code ?? 1005, ""));
    },

    addEventListener: target.addEventListener.bind(target) as S2sWebSocket["addEventListener"],

    open(): void {
      if (sock.dead || sock.readyState === OPEN) return;
      sock.readyState = OPEN;
      target.dispatchEvent(new Event("open"));
    },

    deliverRaw(data: string): void {
      if (sock.readyState !== OPEN) return;
      target.dispatchEvent(new MessageEvent("message", { data }));
    },

    deliver(frame: Record<string, unknown>): void {
      sock.deliverRaw(JSON.stringify(frame));
    },

    drop(code: number, reason = ""): void {
      emitClose(code, reason);
    },

    socketError(message: string): void {
      if (sock.dead) return;
      const ev = new Event("error");
      Object.defineProperty(ev, "message", { value: message });
      target.dispatchEvent(ev);
    },
  }) as unknown as FakeS2sSocket;

  function emitClose(code: number, reason: string): void {
    if (sock.dead) return;
    sock.dead = true;
    sock.readyState = CLOSED;
    const ev = new Event("close");
    Object.assign(ev, { code, reason });
    target.dispatchEvent(ev);
  }

  return sock;
}

/** Create the fake link. Sockets are created closed; a command opens them. */
export function createFakeS2sLink(): FakeS2sLink {
  const state: LinkState = {
    sockets: [],
    issuedSessionIds: new Set(),
    calls: new Map(),
    resumeRequests: [],
  };
  return {
    createWebSocket: () => {
      const sock = makeSocket(state.sockets.length, state);
      state.sockets.push(sock);
      return sock;
    },
    sockets: state.sockets,
    issuedSessionIds: state.issuedSessionIds,
    calls: state.calls,
    resumeRequests: state.resumeRequests,
    current: () => state.sockets.at(-1),
    unopened: () => state.sockets.findLast((s) => !s.dead && s.readyState === CONNECTING),
    noteCall: (callId, socketId, replyId) => {
      state.calls.set(callId, {
        callId,
        socketId,
        replyId,
        replyEnded: null,
        answers: 0,
        survivedResume: false,
      });
    },
    endReply: (status, callIds) => {
      for (const id of callIds) {
        const record = state.calls.get(id);
        if (record?.replyEnded === null) record.replyEnded = status;
      }
    },
    markSurvivedResume: (callIds) => {
      for (const id of callIds) {
        const record = state.calls.get(id);
        if (record !== undefined) record.survivedResume = true;
      }
    },
  };
}

/**
 * Frames that must be tolerated rather than understood: a service that ships a
 * new event type, a truncated frame, a field with the wrong type. The parse
 * layer's contract is to drop and warn — never to throw out of the socket's
 * `message` handler, which would be an uncaughtException on the host.
 */
export const MALFORMED_FRAMES: readonly (string | Record<string, unknown>)[] = [
  "{not json",
  "[1,2,3]",
  "null",
  '"a string"',
  { type: "reply.started" }, // required reply_id missing
  { type: "transcript.user", item_id: 7, text: null }, // wrong types
  { type: "tool.call", call_id: "x" }, // required name missing
  { type: "future.event", payload: { nested: [1, 2] } }, // unknown type
  { type: "reply.audio", data: 42 }, // audio that is not base64 text
  {}, // no type at all
];
