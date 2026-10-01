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
 *   `?token=` is the fallback. `aai-ui` offers it after `aai.session`, which
 *   {@link selectSessionProtocol} selects.
 * - **Resume ownership.** A ticket bound to a session opens only that session;
 *   an unbound one resumes only what its `sub` opened. See {@link SessionGate.admits}.
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

import type http from "node:http";
import type { Duplex } from "node:stream";
import { requestQuery } from "@alexkroman1/aai/internal";
import { SESSION_AUTH_PROTOCOL_PREFIX as WIRE_AUTH_PREFIX } from "@alexkroman1/aai/protocol";
import { omitUndefined } from "@alexkroman1/aai/utils";
import type { WebSocket, WebSocketServer } from "ws";
import type { Logger } from "../runtime-config.ts";
import { agentGateToken } from "./env.ts";
import { declineSocket } from "./session-decline.ts";
import { requireSecret, type SessionIdentity, verifySessionToken } from "./session-ticket.ts";

// The ticket's format lives in `session-ticket.ts`; these were declared here
// first, and every importer still reaches them through this module.
export {
  createSessionToken,
  type SessionIdentity,
  type SessionTokenInput,
  type VerifySessionTokenOptions,
  verifySessionToken,
} from "./session-ticket.ts";

/** The env variable that turns the built-in ticket check on. */
export const SESSION_SECRET_ENV = "AAI_SESSION_SECRET";

/** `Sec-WebSocket-Protocol` entry prefix a ticket travels under (the SDK's wire value). */
export const SESSION_AUTH_PROTOCOL_PREFIX = WIRE_AUTH_PREFIX;

/**
 * The close code a refused session ends with — HTTP 401 in the 4000-4999
 * application range, so a client can tell "not allowed" from a dropped network.
 */
export const SESSION_UNAUTHORIZED_CLOSE_CODE = 4401;

/** Session owners remembered for the resume check, oldest evicted first. */
const MAX_TRACKED_SESSIONS = 10_000;

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
   * A ticket BOUND to a session (`sessionId`) opens exactly that session — it
   * resumes it, or starts it under that id when nothing is there — whatever the
   * URL names: the binding is the authority, and {@link SessionGate.ownership}
   * makes it the session's id. That is how the managed platform's tickets work
   * (a new session's ticket names a fresh id), and how a client resumes across
   * a server restart.
   *
   * An UNBOUND ticket resumes only a session this process saw the same `sub`
   * open. A restarted server that never saw it, or a different caller, is
   * refused: failing closed is the point, since a session id reaching the wrong
   * hands is exactly what this check exists for.
   */
  admits(req: http.IncomingMessage, resumeFrom: string | undefined): Promise<SessionAdmission>;
  /** Record that `identity` opened `sessionId`, for a later resume. */
  recordOwner(sessionId: string, identity: SessionIdentity | undefined): void;
  /**
   * The `startSession` options for an admitted identity: record the owner of
   * the session it opens, and — for a bound ticket — open THAT session.
   */
  ownership(identity: SessionIdentity | undefined): {
    onSinkCreated?: (sessionId: string) => void;
    resumeFrom?: string;
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
    // A bound ticket opens its own session, never another (see `ownership`).
    if (resumeFrom === undefined || identity.sessionId !== undefined) return;
    if (owners.get(resumeFrom) === identity.sub) return;
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
      return {
        onSinkCreated: (sessionId) => gate.recordOwner(sessionId, identity),
        ...omitUndefined({ resumeFrom: identity.sessionId }),
      };
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
