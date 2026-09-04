// Copyright 2026 the AAI authors. MIT license.
/**
 * The guest's end of the platform wire, as ONE multiplexed WebSocket.
 *
 * Every guest→platform call — session state, upload records, the replay
 * engine's journal, its correlation-key index, and an enqueue — used to be its
 * own `POST` on a pooled HTTP/1.1 connection (`_egress-fetch.ts`'s `rpcFetch`).
 * They now ride one socket per process, opened once by `installWorkflowSupport`
 * and shared by all five clients, with the frames declared in
 * `platform-socket-frames.ts`.
 *
 * ## What does NOT change, and it is nearly everything
 *
 * The socket is a TRANSPORT swap and nothing else. A frame names one of
 * `PLATFORM_ROUTES` and carries the same already-encoded body the `POST` carried;
 * the platform runs it through the same Hono app and answers with the status that
 * route would have answered. So `platform-rpc.ts`'s error taxonomy, every
 * `errorFor`, `RETRYABLE_STATUS`, the `{result}` envelope and each caller's own
 * deadline all keep working unread — which is the property that made this safe to
 * do at all, and the reason the swap lives under `platformPost` rather than in
 * five clients.
 *
 * ## HTTP is the FALLBACK, and a call may never be sent twice
 *
 * `platformPost` prefers this socket and uses `rpcFetch` whenever there is not an
 * open one — the first call of a process (the connect is in flight), a
 * deployment whose platform predates the route, a socket that is reconnecting.
 * That keeps availability exactly what it was: nothing here can fail a call that
 * HTTP would have served.
 *
 * The boundary is the frame WRITE, and it is a correctness boundary rather than a
 * tidiness one. {@link PlatformSocket.send} refuses before writing — no socket,
 * or too many in flight — with {@link PLATFORM_SOCKET_UNAVAILABLE_CODE}, and that
 * refusal is what licenses the HTTP retry, because the platform has provably not
 * seen the call. Once the frame is on the wire the call is committed: a socket
 * that dies under it rejects with {@link PLATFORM_UNAVAILABLE_CODE} — the same
 * code a 503 carries — so the engine's own retry decides, exactly as it does for
 * an HTTP connection reset today. Re-sending a written frame over HTTP would turn
 * one `appendEvents` into two.
 *
 * ## A half-open socket is the failure this has and HTTP does not
 *
 * A pooled `fetch` has undici's keep-alive timeout and per-request connect
 * handling underneath it; a WebSocket that is silently black-holed stays "open"
 * forever, and every call on it would burn its own deadline before failing. So
 * the guest pings every {@link HEARTBEAT_MS} and tears the socket down when a
 * pong does not come back within {@link PONG_DEADLINE_MS} — an APPLICATION ping,
 * answered by the same loop that answers requests, for the reason
 * `platform-socket-frames.ts` gives.
 *
 * ## One socket per process, and one Modal input for its life
 *
 * The platform's web service counts a WebSocket as ONE input for its whole
 * lifetime (`modal_deploy.py`, `MAX_INPUTS`), where the requests this replaces
 * were short-lived ones. That is the capacity trade this change makes and it is
 * documented there; it is also why there is exactly one socket per guest process
 * rather than one per client or per run.
 *
 * The whole wire, both ends, is in `aai-server/PLATFORM-SOCKET-CLAUDE.md`.
 *
 * @module platform-socket
 */

import { jitteredBackoff } from "@alexkroman1/aai/internal";
import { isRecord, omitUndefined } from "@alexkroman1/aai/utils";
import { createRestartableTimer } from "./_timer.ts";
import { type HeaderWebSocket, openHeaderWebSocket } from "./_ws.ts";
import {
  MAX_PLATFORM_SOCKET_FRAME_BYTES,
  PLATFORM_SOCKET_PATH,
  type PlatformRoute,
} from "./platform-endpoint.ts";
import {
  PlatformOutboundFrameSchema,
  type PlatformRequestFrame,
  parsePlatformFrame,
} from "./platform-socket-frames.ts";
import { consoleLogger, type Logger } from "./runtime-config.ts";
import { PLATFORM_UNAVAILABLE_CODE } from "./workflow-api-error-status.ts";

/** `ws`'s `OPEN`, spelled rather than imported — {@link HeaderWebSocket} is structural. */
const WS_OPEN = 1;

/**
 * How often the guest asks whether the platform's loop is still answering.
 *
 * Under `EGRESS_KEEP_ALIVE_MS` (30s), deliberately: that is how long the HTTP
 * pool this replaces would hold an idle connection before proving liveness the
 * only way it can — by opening a new one. A socket has no such moment, so the
 * heartbeat is it.
 */
export const HEARTBEAT_MS = 20_000;

/**
 * How long a pong may take before the socket is presumed dead.
 *
 * Half the heartbeat, so a dead socket is detected inside one window rather than
 * two, and comfortably above any real answer: a pong is answered by the dispatch
 * loop without touching a database, so it costs one round trip.
 */
export const PONG_DEADLINE_MS = 10_000;

/**
 * How long a written call may stay pending before this end gives up on it.
 *
 * A caller's own deadline (`PlatformCall.timeoutMs`, 5-20s) fails the CALL, and
 * `pTimeout` cannot reach into the pending map to forget it — so without this a
 * platform that answers pings while wedging one route leaks a slot per timed-out
 * call, and `MAX_INFLIGHT` eventually refuses everything. Swept on the heartbeat
 * rather than timed per call: this is a leak guard, not a deadline, and the one a
 * caller reads is its own.
 *
 * Three times the longest of those deadlines (the enqueue's 20s), so a call this
 * expires is one every caller has already given up on.
 */
const PENDING_CEILING_MS = 60_000;

/** First reconnect delay. Short — a redeploy's socket should come back within a turn. */
const RECONNECT_BASE_MS = 500;

/**
 * Longest reconnect delay.
 *
 * A guest whose platform is down is not idle: every call is falling back to HTTP
 * and failing there too, so a slow reconnect costs nothing and a fast one adds
 * handshakes to an origin that is already refusing them.
 */
const RECONNECT_MAX_MS = 30_000;

/**
 * Calls that may be on the wire at once.
 *
 * Above the widest burst the RPC path issues — `StepGate`'s 16 plus the
 * run-level reads, the same burst `EGRESS_CONNECTIONS` is sized for — so this
 * bounds rather than shapes. What it actually stops is a wedged platform turning
 * an unbounded pending map into the guest's memory ceiling; a call over the cap
 * is refused BEFORE the write and therefore goes to HTTP, which costs the caller
 * nothing.
 *
 * Deliberately UNDER the platform's own `MAX_SOCKET_INFLIGHT` (128), so this cap
 * is the one that binds: a refusal here is a fallback, where the platform's is a
 * 503 the caller has to retry.
 */
const MAX_INFLIGHT = 64;

/**
 * The code on a refusal that means "this call was never sent".
 *
 * A property rather than a subclass, for the reason `platform-rpc.ts` gives about
 * `PLATFORM_UNAVAILABLE_CODE`: a deployed guest holds two copies of this package
 * (the harness's and the worker bundle's), so a class declared here would have
 * two identities and the wrong copy could not recognise it.
 *
 * @internal
 */
export const PLATFORM_SOCKET_UNAVAILABLE_CODE = "PLATFORM_SOCKET_UNAVAILABLE";

/** Is this the refusal that licenses an HTTP retry? See the module doc. */
export function isPlatformSocketUnavailable(err: unknown): boolean {
  return isRecord(err) && err.code === PLATFORM_SOCKET_UNAVAILABLE_CODE;
}

function unavailable(reason: string): Error {
  return Object.assign(new Error(`platform socket unavailable: ${reason}`), {
    code: PLATFORM_SOCKET_UNAVAILABLE_CODE,
  });
}

/** A socket that died with the call already written — retryable, like a 503. */
function droppedInFlight(reason: string): Error {
  return Object.assign(new Error(`platform socket ${reason} with the call in flight`), {
    code: PLATFORM_UNAVAILABLE_CODE,
  });
}

/** What the platform answered: the status the same route would have answered, and its body. */
export type PlatformSocketReply = { status: number; body: string };

export type PlatformSocket = {
  /** Is there an open socket right now — i.e. may a caller prefer this over HTTP? */
  isOpen(): boolean;
  /**
   * Send one call and wait for its reply.
   *
   * Rejects with {@link PLATFORM_SOCKET_UNAVAILABLE_CODE} when the call was NOT
   * written (so the caller may use HTTP), and with
   * {@link PLATFORM_UNAVAILABLE_CODE} when it was written and the socket then
   * failed. It applies no deadline of its own — `platformPost` owns that, and one
   * timeout per call is the contract every caller already reads.
   */
  send(call: {
    route: PlatformRoute;
    body: string;
    traceparent: string | undefined;
  }): Promise<PlatformSocketReply>;
  /** Stop reconnecting and drop the socket. Idempotent. */
  close(): void;
};

/** How a socket is opened — the seam a spec fills. */
export type CreatePlatformWebSocket = (
  url: string,
  opts: { headers: Record<string, string> },
) => HeaderWebSocket;

export type CreatePlatformSocketOptions = {
  /** `AAI_PLATFORM_BASE_URL`, slug included — the same value every HTTP call uses. */
  base: string;
  /** `AAI_GUEST_TOKEN`, presented as the bearer on the UPGRADE. */
  token: string;
  /** Test seam. Production opens a `ws` client — see {@link openPlatformWebSocket}. */
  create?: CreatePlatformWebSocket | undefined;
  logger?: Logger | undefined;
};

/**
 * `<base>/platform-socket` with a WebSocket scheme.
 *
 * The scheme is swapped rather than left alone because a base is an HTTP origin
 * by construction (`agentPlatformBaseUrl` builds one) and `ws` should be handed
 * the spelling that says what this is. `wss:` for `https:` keeps the hop
 * encrypted, which is the whole reason the tunnel is https in the first place.
 */
export function platformSocketUrl(base: string): string {
  const url = new URL(`${base.replace(/\/+$/, "")}${PLATFORM_SOCKET_PATH}`);
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  return url.toString();
}

/**
 * The production socket: `ws`, with the bearer on the handshake.
 *
 * The token rides an `authorization` HEADER and never the URL, for the reason
 * every other credential here does — a query string is logged by proxies, and
 * Modal's is in front of this one. Node's native `WebSocket` cannot set headers,
 * which is why this goes through `_ws.ts`'s `openHeaderWebSocket`: that module
 * owns the one narrowing into {@link HeaderWebSocket}, and opening a second `ws`
 * client here would mean writing it again. The CAP is why it is that function
 * rather than `defaultCreateHeaderWebSocket` — see its doc for why the cap is not
 * a parameter of the contracted factory type.
 *
 * `perMessageDeflate` stays off, matching every other socket this package opens
 * (`PROVIDER_WS_OPTIONS`, applied by that factory). These bodies WOULD compress,
 * unlike the PCM `_ws.ts` measured — but the cost it measured (a zlib context
 * pair per socket) is paid whether or not a frame benefits, and nothing has
 * measured the trade on this path. Turning it on is a one-line, one-measurement
 * change; leaving it on by inheritance is not.
 */
const openPlatformWebSocket: CreatePlatformWebSocket = (url, opts) =>
  openHeaderWebSocket(url, {
    headers: opts.headers,
    maxPayload: MAX_PLATFORM_SOCKET_FRAME_BYTES,
  });

type Pending = {
  resolve: (reply: PlatformSocketReply) => void;
  reject: (err: Error) => void;
  /** When the frame was written, for {@link PENDING_CEILING_MS}. */
  at: number;
};

/**
 * Build one platform socket. It connects immediately and reconnects for as long
 * as it is not {@link PlatformSocket.close}d.
 *
 * @internal
 */
export function createPlatformSocket(opts: CreatePlatformSocketOptions): PlatformSocket {
  const log = opts.logger ?? consoleLogger;
  const create = opts.create ?? openPlatformWebSocket;
  const url = platformSocketUrl(opts.base);
  const pending = new Map<number, Pending>();
  let socket: HeaderWebSocket | undefined;
  let nextId = 1;
  let attempt = 0;
  let closed = false;
  /** The ping whose pong is outstanding, or `undefined` when none is. */
  let awaitingPong: number | undefined;

  /** Give up on calls every caller has already given up on — see {@link PENDING_CEILING_MS}. */
  function sweepPending(): void {
    const deadline = Date.now() - PENDING_CEILING_MS;
    for (const [id, entry] of pending) {
      if (entry.at > deadline) continue;
      pending.delete(id);
      entry.reject(droppedInFlight("never answered"));
    }
  }

  const heartbeat = createRestartableTimer(() => {
    sweepPending();
    if (awaitingPong !== undefined) {
      // A pong that never came. The socket reads as open and answers nothing,
      // which is the one failure mode a deadline per call cannot distinguish from
      // a slow platform — see the module doc.
      log.warn("platform socket heartbeat timed out", { url, waitedMs: PONG_DEADLINE_MS });
      drop("heartbeat timed out");
      return;
    }
    if (socket?.readyState !== WS_OPEN) return;
    awaitingPong = nextId++;
    socket.send(JSON.stringify({ t: "ping", id: awaitingPong }));
    heartbeat.arm(PONG_DEADLINE_MS);
  });

  /** Fail every written call and tear the socket down, then schedule a reconnect. */
  function drop(reason: string): void {
    heartbeat.clear();
    awaitingPong = undefined;
    const dying = socket;
    socket = undefined;
    for (const [, entry] of pending) entry.reject(droppedInFlight(reason));
    pending.clear();
    // 1001 "going away": this end is the one giving up, and a statusless close is
    // reported by both peers as 1005, which is indistinguishable from the socket
    // simply vanishing (see `HeaderWebSocket.close`).
    try {
      dying?.close(1001);
    } catch {
      // Already gone. There is nothing a close can add.
    }
    if (!closed) scheduleReconnect();
  }

  const reconnect = createRestartableTimer(() => {
    if (!closed) connect();
  });

  function scheduleReconnect(): void {
    attempt += 1;
    const delay = jitteredBackoff(attempt, {
      baseMs: RECONNECT_BASE_MS,
      maxMs: RECONNECT_MAX_MS,
    });
    reconnect.arm(delay);
  }

  function onMessage(raw: unknown): void {
    const text = typeof raw === "string" ? raw : String(raw);
    const frame = parsePlatformFrame(PlatformOutboundFrameSchema, text);
    if (frame === undefined) {
      // Forwards compatibility, not leniency: a frame this build does not know is
      // how a newer platform would add one. See `parsePlatformFrame`.
      log.debug("platform socket dropped an unreadable frame", { url });
      return;
    }
    if (frame.t === "pong") {
      if (frame.id !== awaitingPong) return;
      awaitingPong = undefined;
      heartbeat.arm(HEARTBEAT_MS);
      return;
    }
    const entry = pending.get(frame.id);
    if (entry === undefined) {
      // Only reachable if the two ends disagree about ids — a reply to a call this
      // side already failed (a heartbeat drop that raced the answer), or a bug.
      log.debug("platform socket reply had no pending call", { url, id: frame.id });
      return;
    }
    pending.delete(frame.id);
    entry.resolve({ status: frame.status, body: frame.body });
  }

  function connect(): void {
    if (closed || socket !== undefined) return;
    let opening: HeaderWebSocket;
    try {
      opening = create(url, { headers: { authorization: `Bearer ${opts.token}` } });
    } catch (err: unknown) {
      // A malformed URL, or `ws` refusing the options. Nothing to close, and the
      // next attempt will fail the same way — which is what the backoff is for.
      log.warn("platform socket could not be created", { url, error: String(err) });
      scheduleReconnect();
      return;
    }
    socket = opening;
    opening.addEventListener("open", () => {
      if (socket !== opening) return;
      attempt = 0;
      log.debug("platform socket open", { url });
      heartbeat.arm(HEARTBEAT_MS);
    });
    opening.addEventListener("message", (event) => {
      if (socket === opening) onMessage(event.data);
    });
    opening.addEventListener("close", (event) => {
      if (socket !== opening) return;
      // Every close is worth a line and none is worth a warn on its own: the
      // platform retires a replica on every deploy, so a closed socket is ordinary
      // and only a call failing on it is news (the caller logs that).
      log.debug("platform socket closed", { url, code: event.code });
      drop(`closed (${event.code ?? "no code"})`);
    });
    opening.addEventListener("error", (event) => {
      if (socket !== opening) return;
      // A handshake refusal lands here — a platform without the route answers 404,
      // an unauthorized guest 401 — and so does a transport fault. It is a WARN
      // because a socket that never opens means every call is silently on HTTP,
      // which is exactly the state that is otherwise invisible.
      log.warn("platform socket error", { url, error: event.message ?? "unknown" });
      drop("errored");
    });
  }

  connect();

  return {
    isOpen: () => socket?.readyState === WS_OPEN && pending.size < MAX_INFLIGHT,
    async send(call): Promise<PlatformSocketReply> {
      const live = socket;
      if (live?.readyState !== WS_OPEN) throw unavailable("not connected");
      if (pending.size >= MAX_INFLIGHT)
        throw unavailable(`${MAX_INFLIGHT} calls already in flight`);
      const id = nextId++;
      const frame: PlatformRequestFrame = {
        t: "req",
        id,
        route: call.route,
        body: call.body,
        ...omitUndefined({ traceparent: call.traceparent }),
      };
      const settled = Promise.withResolvers<PlatformSocketReply>();
      pending.set(id, { resolve: settled.resolve, reject: settled.reject, at: Date.now() });
      try {
        live.send(JSON.stringify(frame));
      } catch (err: unknown) {
        // The write itself threw, so nothing reached the platform and this call is
        // still eligible for HTTP. Everything after this point is committed.
        pending.delete(id);
        throw unavailable(`write failed: ${String(err)}`);
      }
      return await settled.promise;
    },
    close(): void {
      closed = true;
      reconnect.clear();
      drop("closed by this process");
    },
  };
}
