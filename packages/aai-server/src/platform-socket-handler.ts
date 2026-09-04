// Copyright 2026 the AAI authors. MIT license.
/**
 * `WS /:slug/platform-socket` — the platform's end of a guest's multiplexed
 * socket.
 *
 * A deployed guest used to `POST` each of its five platform calls
 * (`aai-runtime/platform-endpoint.ts`); it now opens one socket for the life of
 * the process and frames them. This module accepts that upgrade and answers the
 * frames. `aai-runtime/platform-socket.ts` is the other end, and
 * `PLATFORM-SOCKET-CLAUDE.md` beside this file carries the whole wire.
 *
 * ## A frame is dispatched through the SAME app, as a real Request
 *
 * The one design decision here, and everything else follows from it: a request
 * frame is turned back into a `POST /:slug/<route>` and handed to `app.fetch`.
 * Not a switch over the five handlers — that would be a second dispatch with its
 * own copy of the bearer check, the body caps, the 400/501/503 taxonomy and
 * `withReserved`'s admin-pool accounting, i.e. exactly the "four copies of a
 * transport" shape `platform-rpc.ts` was written to end, rebuilt on the other
 * side of the wire.
 *
 * What that buys, concretely: the route's `bodyLimit` still refuses an oversized
 * body with its own 413, `assertGuestBearer` still runs PER CALL rather than only
 * at the handshake, an `HTTPException` still becomes the status the route
 * decided, and a route added tomorrow is reachable over the socket with no edit
 * here. What it costs is one `Request`/`Response` pair per call, which is the
 * allocation the HTTP path was already making.
 *
 * ## The socket is pinned to ONE slug, at the handshake
 *
 * The upgrade path names the slug and the bearer is checked against it before the
 * socket is accepted, by the same `guest-bearer.ts` policy every route runs. Every
 * frame is then dispatched under THAT slug — a frame cannot name another agent,
 * because it does not name an agent at all, only one of `PLATFORM_ROUTES`. So the
 * tenant boundary is a property of the connection rather than something each
 * frame has to be checked for.
 *
 * The per-route check still runs underneath, and is not redundant: a bearer is
 * verified against the agent's CURRENT version, so a redeploy during the life of
 * a socket must invalidate it. It does — the next frame's own check answers 401,
 * and the guest reconnects with the token its new sandbox holds.
 *
 * ## What this costs the web service
 *
 * A WebSocket is ONE Modal input for its whole lifetime, so a running agent guest
 * now holds an input on some replica for as long as it lives, where before it
 * made short requests that any replica could serve. `modal_deploy.py` carries the
 * accounting; the two mechanical consequences here are that a socket is idle-
 * reaped ({@link PLATFORM_SOCKET_IDLE_MS}) so a guest that vanished without a
 * close cannot hold one forever, and that the function timeout (4h) will cut a
 * long-lived socket, which the guest treats as any other close.
 *
 * @module platform-socket-handler
 */

import { errorMessage } from "@alexkroman1/aai";
import {
  MAX_PLATFORM_SOCKET_FRAME_BYTES,
  PLATFORM_ROUTES,
  PLATFORM_SOCKET_PATH,
  PlatformInboundFrameSchema,
  type PlatformReplyFrame,
  parsePlatformFrame,
} from "@alexkroman1/aai-runtime/internal";
import type { Hono } from "hono";
import { WebSocketServer } from "ws";
import { answerUpgrade } from "./_upgrade-reply.ts";
import type { HonoEnv } from "./context.ts";
import { guestBearerRefusal } from "./guest-bearer.ts";
import { createLogger } from "./logger.ts";
import { SLUG_PATTERN_SOURCE } from "./schemas.ts";

const log = createLogger("http.platform-socket");

/**
 * The upgrade path grammar: `/<slug>/platform-socket`.
 *
 * Enforced here rather than by a router because a WebSocket upgrade bypasses
 * Hono entirely, exactly as `orchestrator-ws.ts` documents for its own path, and
 * composed from the shared slug grammar so there is one source of truth.
 */
const PLATFORM_SOCKET_RE = new RegExp(
  `^\\/(${SLUG_PATTERN_SOURCE})${PLATFORM_SOCKET_PATH.replace("/", "\\/")}$`,
);

/** The slug an upgrade path names, or `undefined` when it is not this endpoint. */
export function platformSocketSlug(pathOnly: string): string | undefined {
  return PLATFORM_SOCKET_RE.exec(pathOnly)?.[1];
}

/**
 * Frames one socket may have in flight before this end refuses.
 *
 * Twice the guest's own cap, deliberately, and the ORDER is the design: the
 * guest refuses at 64 by falling back to HTTP, which costs a caller nothing. A
 * 503 from here is a real answer that a caller must retry, so this end's cap is
 * the backstop for a peer that is not ours rather than the one that normally
 * binds.
 *
 * It is a cap at all because each dispatch may reserve one of `ADMIN_POOL_MAX`
 * connections — an unbounded socket is a single tenant queueing the pool every
 * other tenant reads through.
 */
const MAX_SOCKET_INFLIGHT = 128;

/**
 * How long a socket may go without a frame before this end closes it.
 *
 * The guest pings every 20s (`HEARTBEAT_MS`), so four and a half missed windows.
 * Generous because the cost of being wrong is asymmetric — closing a live socket
 * fails nothing (the guest reconnects and calls fall back meanwhile) but does add
 * a reconnect to every long-idle agent — and the cost of never closing is a Modal
 * input held by a sandbox that no longer exists.
 */
export const PLATFORM_SOCKET_IDLE_MS = 90_000;

/** Every route a frame may name — the table, so this cannot drift from the HTTP routes. */
const ROUTES = new Set<string>(Object.values(PLATFORM_ROUTES));

export type PlatformSocketOptions = {
  /** The platform app itself. A frame is dispatched through it — see the module doc. */
  app: Hono<HonoEnv>;
  /**
   * Reads the agent's current version, for the handshake's bearer check.
   *
   * ONE method rather than the whole `BundleStore`, for the reason
   * `guestBearerRefusal` takes a reader rather than a store: that is the whole
   * of what this module reads, and a spec for the frame loop — which reads
   * nothing at all — should not have to conjure a store to say so.
   */
  store: { getAgentVersion(slug: string): Promise<number | null> };
  /**
   * True once this replica is shutting down.
   *
   * A draining replica REFUSES a new socket, which is a change in kind rather
   * than in degree: `orchestrator.ts` used to say there was nothing to refuse
   * here because every upgrade was an instant handshake redirect, and this is
   * the first one that is not. Accepting one during a drain hands a guest a
   * transport that dies inside the shutdown window, and the guest is better
   * served by the HTTP fallback — which any replica can answer — until it dials
   * a replica that is staying.
   *
   * Existing sockets are NOT torn down here: the drain already retires this
   * replica's guests on their own clock, and cutting their transport mid-call
   * would fail the very calls that retirement is waiting on.
   */
  isDraining?: (() => boolean) | undefined;
};

/**
 * Answer one request frame by running it through the app.
 *
 * Every failure mode below the app is already a status: this only has to turn a
 * throw that escaped the app's own error handler into one, which is a 500 because
 * an escaped throw is by definition unclassified (`error-handler.ts` is what
 * classifies the rest).
 */
async function dispatch(
  opts: PlatformSocketOptions,
  ctx: { origin: string; slug: string; authorization: string },
  frame: { route: string; body: string; traceparent?: string | undefined },
): Promise<{ status: number; body: string }> {
  if (!ROUTES.has(frame.route)) {
    // The guest builds this from the same table, so a route it does not hold is a
    // version skew rather than a caller mistake — 404 is what the HTTP path would
    // have answered for the same reason.
    return { status: 404, body: `no platform route ${frame.route}` };
  }
  const headers: Record<string, string> = {
    authorization: ctx.authorization,
    "content-type": "application/json",
    // The route's `bodyLimit` reads this, and a body with none is measured by
    // draining the stream — correct either way, but stating it keeps a 413 a 413
    // rather than a buffered read of something oversized.
    "content-length": String(Buffer.byteLength(frame.body)),
  };
  if (frame.traceparent !== undefined) headers.traceparent = frame.traceparent;
  const request = new Request(`${ctx.origin}/${ctx.slug}${frame.route}`, {
    method: "POST",
    headers,
    body: frame.body,
  });
  try {
    const res = await opts.app.fetch(request);
    return { status: res.status, body: await res.text() };
  } catch (err: unknown) {
    log.error("platform socket dispatch failed", {
      slug: ctx.slug,
      route: frame.route,
      error: errorMessage(err),
    });
    return { status: 500, body: "Internal server error" };
  }
}

/**
 * Why this handshake may not open, or `undefined` when it may.
 *
 * Its own function so the POLICY is reachable without a socket: the alternative
 * is a spec that conjures an `IncomingMessage`, which means a cast, which is the
 * thing that stops reporting the moment the shape moves.
 *
 * Both answers are a real HTTP status on the upgrade, never a destroyed socket —
 * `_upgrade-reply.ts` carries why, and on this path a bare RST would present as a
 * guest silently and permanently on the HTTP fallback.
 *
 * @internal
 */
export async function platformHandshakeRefusal(
  opts: PlatformSocketOptions,
  req: { authorization: string | undefined; slug: string },
): Promise<{ status: string; body: string } | undefined> {
  if (opts.isDraining?.() === true) {
    // A draining replica refuses rather than accepting a socket it is about to
    // drop: the guest keeps using HTTP, which any replica still serves, until it
    // dials one that is staying.
    return { status: "503 Service Unavailable", body: "draining\n" };
  }
  // The same policy every guest-called route runs, asked before a socket exists.
  // Per-frame checks still happen underneath — see the module doc on why both.
  const refusal = await guestBearerRefusal({
    authorization: req.authorization,
    slug: req.slug,
    getAgentVersion: (s) => opts.store.getAgentVersion(s),
  });
  if (refusal === undefined) return undefined;
  return { status: `${refusal.status} ${refusal.statusText}`, body: `${refusal.message}\n` };
}

/** Where one socket's answers go. Injected, so the frame loop is testable without one. */
export type PlatformFrameSink = (frame: PlatformReplyFrame | { t: "pong"; id: number }) => void;

/** What one accepted socket knows about its peer, decided at the handshake. */
export type PlatformSocketContext = { origin: string; slug: string; authorization: string };

/**
 * The frame loop for one socket, with the socket itself factored out.
 *
 * Everything a frame can do to this server is here — the route allowlist, the
 * heartbeat answer, the in-flight cap, the dispatch and its 500 — and none of it
 * needs a port, which is why it is a function taking a SINK rather than code
 * inside `acceptPlatformSocket`. `platform-socket-handler.test.ts` drives it
 * directly against a real Hono app; the scenario spec beside it covers the part
 * that genuinely needs a socket, which is the handshake and the plumbing.
 *
 * @internal
 */
export function createPlatformFrameLoop(
  opts: PlatformSocketOptions,
  ctx: PlatformSocketContext,
  send: PlatformFrameSink,
): (data: unknown) => void {
  let inflight = 0;
  return (data: unknown) => {
    const frame = parsePlatformFrame(PlatformInboundFrameSchema, String(data));
    if (frame === undefined) {
      // Forwards compatibility, not leniency: a frame kind this build does not
      // know is how a newer guest would add one, and closing over it would take
      // that guest's whole transport down. See `parsePlatformFrame`.
      log.debug("platform socket dropped an unreadable frame", { slug: ctx.slug });
      return;
    }
    if (frame.t === "ping") {
      send({ t: "pong", id: frame.id });
      return;
    }
    if (inflight >= MAX_SOCKET_INFLIGHT) {
      // 503 rather than a close: the socket is healthy and this one call is
      // refused, which is a status the guest's own retry already understands.
      send({ t: "res", id: frame.id, status: 503, body: "platform socket is saturated" });
      return;
    }
    inflight += 1;
    void dispatch(opts, ctx, frame)
      .then((answered) => {
        send({ t: "res", id: frame.id, status: answered.status, body: answered.body });
      })
      .catch((err: unknown) => {
        // `dispatch` contains its own failures, so reaching here is a bug in
        // this module rather than in a route. Answer anyway: a frame with no
        // reply is a call that burns its caller's whole deadline.
        log.error("platform socket frame failed", { slug: ctx.slug, error: errorMessage(err) });
        send({ t: "res", id: frame.id, status: 500, body: "Internal server error" });
      })
      .finally(() => {
        inflight -= 1;
      });
  };
}

/**
 * Accept one upgrade on this endpoint and serve its frames.
 *
 * Answers the HANDSHAKE on a refusal rather than destroying the socket, for the
 * reason `_upgrade-reply.ts` gives: a bare RST is indistinguishable from a
 * network fault, and on this path that would present as a guest permanently and
 * silently on the HTTP fallback.
 *
 * @internal
 */
export async function acceptPlatformSocket(
  opts: PlatformSocketOptions,
  wss: WebSocketServer,
  req: import("node:http").IncomingMessage,
  socket: import("node:stream").Duplex,
  head: Buffer,
  slug: string,
): Promise<void> {
  const authorization = req.headers.authorization ?? "";
  const refusal = await platformHandshakeRefusal(opts, { authorization, slug });
  if (refusal !== undefined) {
    answerUpgrade(socket, refusal.status, refusal.body);
    return;
  }
  const host = req.headers.host ?? "127.0.0.1";
  // A dispatch needs an absolute URL and nothing below reads the scheme: these
  // requests never leave the process, and the public origin a route wants is
  // resolved from configuration rather than from this (`public-origin.ts`).
  const origin = `http://${host}`;
  wss.handleUpgrade(req, socket, head, (ws) => {
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const touch = (): void => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        log.info("platform socket idle, closing", { slug, idleMs: PLATFORM_SOCKET_IDLE_MS });
        ws.close(1001, "idle");
      }, PLATFORM_SOCKET_IDLE_MS);
      // Never hold the process open on this: a replica draining for a redeploy
      // has already told its guests to go away.
      idleTimer.unref?.();
    };
    const handle = createPlatformFrameLoop(opts, { origin, slug, authorization }, (frame) => {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(JSON.stringify(frame));
    });
    touch();
    log.debug("platform socket open", { slug });
    // A SYNC listener that hands the async work to the loop, which `void`s its
    // own promise — `guard-invariants` rule 23: an async function given straight
    // to `.on` has no call site for its rejection to land in.
    ws.on("message", (data: unknown) => {
      touch();
      handle(data);
    });
    ws.on("close", () => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      log.debug("platform socket closed", { slug });
    });
    ws.on("error", (err: unknown) => {
      // `ws` emits this for a protocol fault as well as a transport one, and both
      // end the socket; the guest reconnects.
      log.debug("platform socket error", { slug, error: errorMessage(err) });
    });
  });
}

/**
 * The `WebSocketServer` these sockets are accepted on.
 *
 * `noServer` because the upgrade is routed by `orchestrator-ws.ts` — this server
 * owns the handshake and the framing and never listens on a port of its own.
 * `perMessageDeflate` is left at the SERVER default (off) to match the guest,
 * which declines to offer it; `maxPayload` is the shared cap, so neither end can
 * read a frame the other refused to.
 *
 * @internal
 */
export function createPlatformSocketServer(): WebSocketServer {
  return new WebSocketServer({ noServer: true, maxPayload: MAX_PLATFORM_SOCKET_FRAME_BYTES });
}
