// Copyright 2026 the AAI authors. MIT license.
/**
 * Authenticating `WS /websocket` — the self-hosted server's session door.
 *
 * Until this existed the door had no gate of its own: anyone who could reach the
 * port could open a voice session on the operator's provider credentials, and
 * anyone holding a session id could re-attach to that conversation with
 * `?sessionId=`. Binding loopback by default (`DEFAULT_LISTEN_HOST`) was the only
 * defence, and it stops being one the moment a deployment is meant to be reached.
 *
 * ## Three checks, all at the upgrade
 *
 * - **Origin.** With `allowedOrigins` set, a browser upgrade whose `Origin` is not
 *   listed is refused — cross-site WebSocket hijacking, which nothing prevented.
 *   A request with NO `Origin` passes: only browsers send one, and a non-browser
 *   client can write any value it likes, so the check is only meaningful against
 *   the one caller that cannot lie about it.
 * - **A session ticket.** A short-lived HMAC token ({@link createSessionToken}),
 *   or whatever a caller's own `verify` accepts. Browsers cannot set headers on a
 *   WebSocket, so it rides the `Sec-WebSocket-Protocol` header as
 *   `aai.auth.<token>` — out of the URL, so out of access logs and `Referer` — and
 *   `?token=` is the fallback for a client that cannot offer a subprotocol.
 * - **Resume ownership.** A `?sessionId=` resume is only honoured for the
 *   identity that OPENED that session. See {@link SessionGate.admits}.
 *
 * ## It runs BEFORE the handshake, and the refusal still says why
 *
 * The check is awaited before `wss.handleUpgrade`, not inside its callback: a
 * client may send its first frame the instant the socket opens, and a frame that
 * arrives before `startSession` attaches its listener is dropped. The raw socket
 * is not read until the handshake, so nothing is lost by waiting. A refused
 * socket is still COMPLETED and then declined with a fatal error frame and close
 * code {@link SESSION_UNAUTHORIZED_CLOSE_CODE} — a browser cannot read an HTTP
 * status on a failed upgrade, and the fatal frame is what stops `aai-ui`'s
 * reconnect loop retrying a ticket that will never be accepted.
 *
 * ## Off unless configured
 *
 * No `secret`, no `verify` and no `AAI_SESSION_SECRET` means no ticket check, as
 * before. `allowedOrigins` works on its own.
 *
 * ## A handle, on its own subpath
 *
 * What a server takes is a {@link SessionAuth} from {@link createSessionAuth},
 * published on `@alexkroman1/aai-runtime/auth` with the ticket helpers — never
 * the options bag. The gate's machinery (`resolveSessionGate`,
 * `admitSessionUpgrade`) stays unexported: the server resolves the handle
 * against its own env and logger once, at construction.
 *
 * @module session-auth
 */

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type http from "node:http";
import type { Duplex } from "node:stream";
import { requestQuery } from "@alexkroman1/aai/internal";
import { isRecord, omitUndefined } from "@alexkroman1/aai/utils";
import type { WebSocket, WebSocketServer } from "ws";
import type { Logger } from "./runtime-config.ts";
import { agentGateToken } from "./server-env.ts";
import { declineSocket } from "./session-decline.ts";

/** The env variable that turns the built-in ticket check on. */
export const SESSION_SECRET_ENV = "AAI_SESSION_SECRET";

/** `Sec-WebSocket-Protocol` entry prefix a ticket travels under. */
export const SESSION_AUTH_PROTOCOL_PREFIX = "aai.auth.";

/**
 * The close code a refused session ends with — HTTP 401 in the 4000-4999
 * application range, so a client can tell "not allowed" from a dropped network.
 */
export const SESSION_UNAUTHORIZED_CLOSE_CODE = 4401;

/** Ticket lifetime when {@link SessionTokenInput.ttlSeconds} is omitted. */
const DEFAULT_TTL_SECONDS = 60;

/** Forward clock skew tolerated on a ticket's `iat`, in seconds. */
const CLOCK_SKEW_SECONDS = 30;

/** Longest ticket read — an HMAC ticket is ~150 bytes; this bounds the parse. */
const MAX_TOKEN_LENGTH = 4096;

/** Session owners remembered for the resume check, oldest evicted first. */
const MAX_TRACKED_SESSIONS = 10_000;

/** Who a verified ticket says the caller is. */
export type SessionIdentity = {
  /** The caller's stable id — a user id, an account id. */
  sub: string;
  /**
   * The one session this identity may resume. Set it when the ticket is minted
   * for a reconnect; see {@link SessionGate.admits} for when it is required.
   */
  sessionId?: string;
  /** Application claims carried through verification untouched. */
  claims?: Record<string, unknown>;
};

/** Input to {@link createSessionToken}. */
export type SessionTokenInput = SessionIdentity & {
  /** The same secret the server verifies with — `AAI_SESSION_SECRET`. */
  secret: string;
  /** Seconds until the ticket expires. Defaults to 60: it opens a socket, nothing more. */
  ttlSeconds?: number;
  /** Clock override for tests, in ms since the epoch. */
  now?: number;
};

type TicketPayload = {
  v: 1;
  sub: string;
  iat: number;
  exp: number;
  jti: string;
  sid?: string;
  claims?: Record<string, unknown>;
};

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

function requireSecret(secret: string): void {
  if (secret.trim() === "") throw new Error("A session ticket secret must not be blank");
}

/**
 * Mint a session ticket — call this from your own backend, after your own login
 * check, and hand the result to the browser.
 *
 * ```ts
 * import { createSessionToken } from "@alexkroman1/aai-runtime/auth";
 *
 * const token = createSessionToken({
 *   secret: process.env.AAI_SESSION_SECRET ?? "",
 *   sub: "user-123", // your signed-in user's id
 * });
 * ```
 *
 * The format is `base64url(payload).base64url(HMAC-SHA256(payload))` — no JWT
 * library, and nothing a server holding the secret cannot check in one call.
 */
export function createSessionToken(input: SessionTokenInput): string {
  requireSecret(input.secret);
  if (input.sub === "") throw new Error("A session ticket needs a non-empty `sub`");
  const iat = Math.floor((input.now ?? Date.now()) / 1000);
  const payload: TicketPayload = {
    v: 1,
    sub: input.sub,
    iat,
    exp: iat + (input.ttlSeconds ?? DEFAULT_TTL_SECONDS),
    jti: randomUUID(),
    ...omitUndefined({ sid: input.sessionId, claims: input.claims }),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body, input.secret)}`;
}

/** Options for {@link verifySessionToken}. */
export type VerifySessionTokenOptions = {
  secret: string;
  /** Clock override for tests, in ms since the epoch. */
  now?: number;
};

function parsePayload(body: string): TicketPayload | undefined {
  try {
    const p: unknown = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!isRecord(p)) return undefined;
    if (p.v !== 1 || typeof p.sub !== "string" || p.sub === "") return undefined;
    if (typeof p.iat !== "number" || typeof p.exp !== "number") return undefined;
    if (p.sid !== undefined && typeof p.sid !== "string") return undefined;
    if (p.claims !== undefined && !isRecord(p.claims)) return undefined;
    return {
      v: 1,
      sub: p.sub,
      iat: p.iat,
      exp: p.exp,
      jti: typeof p.jti === "string" ? p.jti : "",
      ...omitUndefined({ sid: p.sid, claims: p.claims }),
    };
  } catch {
    return undefined;
  }
}

/**
 * Check a ticket minted by {@link createSessionToken}: the signature, then the
 * expiry. Returns the identity it carries, or `undefined` for anything else —
 * one answer for forged, expired and malformed, so a caller cannot probe which.
 */
export function verifySessionToken(
  token: string,
  options: VerifySessionTokenOptions,
): SessionIdentity | undefined {
  requireSecret(options.secret);
  if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) return undefined;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".")) return undefined;
  const body = token.slice(0, dot);
  const presented = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(sign(body, options.secret));
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return undefined;
  }
  const payload = parsePayload(body);
  if (payload === undefined) return undefined;
  const now = Math.floor((options.now ?? Date.now()) / 1000);
  if (payload.exp <= now || payload.iat > now + CLOCK_SKEW_SECONDS) return undefined;
  return {
    sub: payload.sub,
    ...omitUndefined({ sessionId: payload.sid, claims: payload.claims }),
  };
}

/** A caller's own ticket check — a JWT from your IdP, an API key lookup. */
export type SessionVerifier = (
  token: string,
  req: http.IncomingMessage,
) => SessionIdentity | null | undefined | Promise<SessionIdentity | null | undefined>;

/**
 * What {@link createSessionAuth} takes.
 *
 * Give `secret` for the built-in ticket ({@link createSessionToken}), or
 * `verify` to check tokens yourself; with neither, `AAI_SESSION_SECRET` in the
 * server's `env` is read. `verify` wins when both are set.
 */
export type SessionAuthOptions = {
  /** HMAC secret for the built-in ticket. */
  secret?: string | undefined;
  /** Your own check. Return the caller's identity, or nothing to refuse. */
  verify?: SessionVerifier | undefined;
  /**
   * Browser origins allowed to open a session, e.g. `["https://app.example.com"]`.
   * Omit to allow any. Checked with or without a ticket requirement.
   */
  allowedOrigins?: readonly string[] | undefined;
};

/**
 * The seal on a {@link SessionAuth}. TYPE-ONLY: there is no value, so only
 * {@link createSessionAuth} mints one.
 *
 * @public
 */
export declare const sessionAuthBrand: unique symbol;

/**
 * Who may open a session on a server — `auth` on `createAgentServer`,
 * `createRuntimeServer` and `createHostServer`. Opaque: build one with
 * {@link createSessionAuth}.
 *
 * @sealed
 * @public
 */
export type SessionAuth = { readonly [sessionAuthBrand]: true };

/** What each handle was built from — the handle itself carries nothing a caller can read. */
const authOptions = new WeakMap<SessionAuth, SessionAuthOptions>();

/**
 * Build the session gate a server applies to `WS /websocket`: a ticket check,
 * an `Origin` allowlist, and resume bound to the identity that opened the
 * session. Pass the result as `auth` to a server.
 *
 * Checked here, at construction, rather than at the first upgrade: a blank
 * `secret` throws, and so does a handle that would check nothing at all.
 *
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 * import { createAgentServer } from "@alexkroman1/aai-runtime";
 * import { createSessionAuth } from "@alexkroman1/aai-runtime/auth";
 *
 * const server = createAgentServer({
 *   agent: agent({ name: "Support" }),
 *   env: {},
 *   auth: createSessionAuth({
 *     secret: process.env.AAI_SESSION_SECRET ?? "",
 *     allowedOrigins: ["https://app.example.com"],
 *   }),
 * });
 * await server.listen(3000);
 * ```
 *
 * @public
 */
export function createSessionAuth(options: SessionAuthOptions): SessionAuth {
  if (options.secret !== undefined) requireSecret(options.secret);
  if (
    options.secret === undefined &&
    options.verify === undefined &&
    options.allowedOrigins === undefined
  ) {
    throw new TypeError(
      "createSessionAuth: pass `secret`, `verify` or `allowedOrigins` — a gate with none of " +
        "them checks nothing (AAI_SESSION_SECRET in the server env needs no handle at all)",
    );
  }
  const handle = Object.freeze({}) as SessionAuth;
  authOptions.set(handle, { ...options });
  return handle;
}

/** The outcome of {@link SessionGate.admits}. */
export type SessionAdmission =
  | { ok: true; identity: SessionIdentity | undefined }
  | { ok: false; reason: string };

/** The resolved gate one server applies to every session upgrade. */
export type SessionGate = {
  /**
   * Decide one upgrade. `resumeFrom` is the session the URL asks to resume.
   *
   * A resume is admitted when the ticket names that session (`sessionId`), or
   * when this process saw the same `sub` open it. Neither — a restarted server
   * that never saw the session open, or a different caller — is refused: failing
   * closed is the point, since a session id reaching the wrong hands is exactly
   * what this check exists for. A client that must resume across a server
   * restart gets a ticket minted with `sessionId`.
   */
  admits(req: http.IncomingMessage, resumeFrom: string | undefined): Promise<SessionAdmission>;
  /** Record that `identity` opened `sessionId`, for a later resume. */
  recordOwner(sessionId: string, identity: SessionIdentity | undefined): void;
  /** The `startSession` option that records the owner of the session it opens. */
  ownership(identity: SessionIdentity | undefined): {
    onSinkCreated?: (sessionId: string) => void;
  };
};

/**
 * The ticket a request presents: the `aai.auth.` subprotocol first, then
 * `?token=`. `""` when neither is present.
 */
export function presentedSessionToken(req: http.IncomingMessage): string {
  const header = req.headers["sec-websocket-protocol"];
  const offered = (Array.isArray(header) ? header.join(",") : (header ?? "")).split(",");
  for (const raw of offered) {
    const protocol = raw.trim();
    if (protocol.startsWith(SESSION_AUTH_PROTOCOL_PREFIX)) {
      return protocol.slice(SESSION_AUTH_PROTOCOL_PREFIX.length);
    }
  }
  return requestQuery(req.url ?? "").get("token") ?? "";
}

/**
 * The subprotocol to answer a handshake with — `ws`'s `handleProtocols`.
 *
 * A browser that OFFERS protocols fails the handshake unless the server selects
 * one, and the default picks the first offered, which would echo a ticket back
 * in the response. So this picks the first offer that is NOT a ticket, and a
 * ticket only when it is all the client offered.
 */
export function selectSessionProtocol(protocols: Set<string>): string | false {
  let fallback: string | false = false;
  for (const protocol of protocols) {
    if (!protocol.startsWith(SESSION_AUTH_PROTOCOL_PREFIX)) return protocol;
    if (fallback === false) fallback = protocol;
  }
  return fallback;
}

/**
 * Build the gate for one server, or `undefined` when nothing is configured —
 * which keeps the upgrade path byte-for-byte what it was for everyone who has
 * not opted in.
 */
export function resolveSessionGate(
  handle: SessionAuth | undefined,
  env: Record<string, string> | undefined,
  logger: Logger,
): SessionGate | undefined {
  const auth = handle === undefined ? undefined : authOptions.get(handle);
  if (handle !== undefined && auth === undefined) {
    throw new TypeError(
      "auth: pass a handle from createSessionAuth() on @alexkroman1/aai-runtime/auth",
    );
  }
  const secret = auth?.secret ?? agentGateToken(env, SESSION_SECRET_ENV, logger);
  const verify: SessionVerifier | undefined =
    auth?.verify ?? (secret !== undefined ? (t) => verifySessionToken(t, { secret }) : undefined);
  const origins = auth?.allowedOrigins;
  if (verify === undefined && origins === undefined) return undefined;

  const owners = new Map<string, string>();

  function resumeRefusal(identity: SessionIdentity, resumeFrom: string | undefined) {
    if (resumeFrom === undefined) {
      // A reconnect ticket is for ONE session; spending it on a fresh one is
      // almost certainly a client bug, and refusing says so.
      return identity.sessionId === undefined ? undefined : "this ticket is for resuming a session";
    }
    if (identity.sessionId === resumeFrom || owners.get(resumeFrom) === identity.sub) return;
    return "this ticket may not resume that session";
  }

  async function identify(req: http.IncomingMessage, check: SessionVerifier) {
    const token = presentedSessionToken(req);
    if (token === "") return;
    try {
      return (await check(token, req)) ?? undefined;
    } catch (err) {
      logger.warn("Session ticket verifier threw", { error: String(err) });
    }
  }

  const gate: SessionGate = {
    async admits(req, resumeFrom) {
      const origin = req.headers.origin;
      if (origins !== undefined && origin !== undefined && !origins.includes(origin)) {
        return { ok: false, reason: `origin ${origin} is not allowed to open a session` };
      }
      if (verify === undefined) return { ok: true, identity: undefined };
      if (presentedSessionToken(req) === "") {
        return { ok: false, reason: "a session ticket is required" };
      }
      const identity = await identify(req, verify);
      if (identity === undefined)
        return { ok: false, reason: "the session ticket was not accepted" };
      const refusal = resumeRefusal(identity, resumeFrom);
      return refusal === undefined ? { ok: true, identity } : { ok: false, reason: refusal };
    },
    recordOwner(sessionId, identity) {
      if (identity === undefined) return;
      owners.delete(sessionId);
      owners.set(sessionId, identity.sub);
      if (owners.size > MAX_TRACKED_SESSIONS) {
        const oldest = owners.keys().next().value;
        if (oldest !== undefined) owners.delete(oldest);
      }
    },
    ownership(identity) {
      if (identity === undefined) return {};
      return { onSinkCreated: (sessionId) => gate.recordOwner(sessionId, identity) };
    },
  };
  return gate;
}

/** What {@link admitSessionUpgrade} needs of the upgrade in hand. */
export type SessionUpgrade = {
  req: http.IncomingMessage;
  socket: Duplex;
  head: Buffer;
  wss: WebSocketServer;
  /** The request path, for the log line. */
  url: string;
  /** The session the URL asks to resume, if any. */
  resumeFrom: string | undefined;
  logger: Logger;
};

/**
 * Complete one session upgrade through `gate`: `accept` on admission, a
 * declined socket with {@link SESSION_UNAUTHORIZED_CLOSE_CODE} otherwise. With
 * no gate this is exactly `wss.handleUpgrade(..., accept)`.
 */
export function admitSessionUpgrade(
  gate: SessionGate | undefined,
  upgrade: SessionUpgrade,
  accept: (ws: WebSocket, identity: SessionIdentity | undefined) => void,
): void {
  const { req, socket, head, wss, url, logger } = upgrade;
  if (gate === undefined) {
    wss.handleUpgrade(req, socket, head, (ws) => accept(ws, undefined));
    return;
  }
  void gate.admits(req, upgrade.resumeFrom).then(
    (admission) => {
      if (admission.ok) {
        wss.handleUpgrade(req, socket, head, (ws) => accept(ws, admission.identity));
        return;
      }
      logger.warn(`WS upgrade ${url} rejected: ${admission.reason}`);
      wss.handleUpgrade(req, socket, head, (ws) => {
        declineSocket(
          ws,
          `unauthorized: ${admission.reason}`,
          logger,
          SESSION_UNAUTHORIZED_CLOSE_CODE,
        );
      });
    },
    (err: unknown) => {
      // `admits` catches a verifier's throw itself; this is the unreachable-by-design
      // arm, and a socket must not dangle if it is ever reached.
      logger.error(`WS upgrade ${url} failed in the session gate`, { error: String(err) });
      socket.destroy();
    },
  );
}
