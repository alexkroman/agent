// Copyright 2026 the AAI authors. MIT license.
/**
 * How the next connection attempt is DIALLED, and the resume identity it dials
 * with.
 *
 * Split out of `session-core.ts` at the 500-line cap, along the seam that file
 * already established when it moved socket plumbing into
 * `session-core-reconnect.ts`: the state machine there reads as protocol logic,
 * and this is the address it sends it to. What makes it one module rather than
 * three extracted functions is that the three pieces of mutable state involved —
 * the session id, whether this connection has ever completed a handshake, and
 * whether the server is a broker — are read by nothing else in the core, and
 * every one of them is only meaningful in the sentence "the URL for the next
 * attempt".
 */

import { loadClientConfig } from "./client-config.ts";
import { resolveReported } from "./client-identity.ts";
import { openReconnectingSocket } from "./session-core-reconnect.ts";
import {
  resolveSessionToken,
  resolveSessionTokenSync,
  type SessionTokenOption,
  type TicketCarriage,
  ticketCarriage,
} from "./session-core-ticket.ts";
import { buildBrokeredWsUrl, buildWsUrl, type ClientReport } from "./session-core-url.ts";
import {
  clearStoredSessionId,
  clearStoredTicket,
  readStoredSessionId,
  readStoredTicket,
  writeStoredSessionId,
  writeStoredTicket,
} from "./session-resume-store.ts";
import type { WebSocketConstructor } from "./types.ts";

/** What the dialer needs from the session's options. */
export type DialOptions = {
  platformUrl: string;
  /** Tests inject one; it connects to the same-origin path and never reconnects. */
  WebSocket?: WebSocketConstructor | undefined;
  /** An id the caller manages itself — wins over what a previous load stored. */
  resumeSessionId?: string | undefined;
  /** Where the client is — see `VoiceSessionOptions.location`. Read per attempt. */
  location?: string | (() => string | undefined) | undefined;
  /** The owner's number — see `VoiceSessionOptions.phone`. Read per attempt. */
  phone?: string | (() => string | undefined) | undefined;
  /** This client's device id — see `VoiceSessionOptions.client`. Read per attempt. */
  client?: string | (() => string | undefined) | undefined;
  /** The session ticket — see `VoiceSessionOptions.token`. Asked per attempt. */
  token?: SessionTokenOption;
};

/** One attempt's address and the subprotocols it offers. */
type Attempt = { url: string; protocols: string[] | undefined };

/** `url` with the `?token=` fallback applied when the ticket rides the URL. */
function withQueryToken(url: URL, carriage: TicketCarriage): string {
  if (carriage.queryToken !== undefined) url.searchParams.set("token", carriage.queryToken);
  return url.toString();
}

export type Dialer = {
  /** A socket for this attempt. */
  open(): InstanceType<WebSocketConstructor>;
  /**
   * A completed handshake: adopt the server's session id and record that this
   * connection has been established, so every later attempt resumes.
   */
  configured(sid: string | undefined): void;
  /** Drop the resume identity, so the next connect is a NEW session. */
  forget(): void;
  /**
   * The session id a `config` frame CONFIRMED — `session.identity.sessionId()`.
   * Not the resume identity above: that one is seeded from storage and from
   * `resume(id)` before any server has said the session exists, and a page
   * keying its history off an id no server confirmed files it under a guess.
   */
  sessionId(): string | undefined;
  /**
   * Make `sid` the resume identity — presented as `?sessionId=` by the next
   * attempt and stored as a `config` frame's would be — so the next connect
   * resumes THAT session. The caller has validated it.
   */
  adopt(sid: string): void;
};

/**
 * @param onSessionId - Told whenever the CONFIRMED id changes (a `config` frame
 *   with a new id, `forget()`), so the session can notify `useSessionId()`
 *   even when no snapshot field moved with it.
 * @internal
 */
export function createDialer(options: DialOptions, onSessionId?: () => void): Dialer {
  /**
   * The session ID to resume: seeded from `options.resumeSessionId`, else from
   * what a previous LOAD of this page stored, then kept current from every
   * `config` frame. Reconnect URLs carry it as `?sessionId=<id>` so the server
   * re-registers the SAME session id — that key is what the session's slot state
   * and event log live under, so an attempt that omits it gets a fresh session
   * with none of the agent's context.
   *
   * Reading it from storage is what makes a page RELOAD resume, and so what makes
   * the server's `syncState` push reach a UI that would otherwise come back
   * empty. See `session-resume-store.ts`.
   */
  let sessionId: string | undefined =
    options.resumeSessionId ?? readStoredSessionId(options.platformUrl);

  /** Whether a handshake has completed on this core — the `resume=1` fallback. */
  let hasConnected = false;

  /**
   * Whether `platformUrl`'s `client-config` says anything per ATTEMPT: a
   * `sessionUrl` (a broker) or a `sessionToken` (a server minting its own
   * client's tickets — `aai dev` with `AAI_SESSION_SECRET`). A server does or it
   * doesn't — it never flips mid-session — so once one that says neither is
   * observed, later reconnects skip the `client-config` re-fetch that would only
   * fall through to `buildWsUrl` (every reconnect on `aai dev` / self-hosted
   * otherwise pays a wasted GET). `undefined` until the first fetch settles.
   */
  let configPerAttempt: boolean | undefined;

  /**
   * The last ticket this server's `client-config` issued, presented on the next
   * lookup that RESUMES (`SESSION_TICKET_HEADER`). On the managed platform a
   * ticket is bound to its session and possession is the resume credential, so
   * it is stored beside the id: a reload that lost it would start over.
   */
  let serverTicket: string | undefined = readStoredTicket(options.platformUrl);

  /** What the last `config` frame said — see `Dialer.sessionId`. */
  let confirmed: string | undefined;

  function confirm(sid: string | undefined): void {
    if (sid === confirmed) return;
    confirmed = sid;
    onSessionId?.();
  }

  /**
   * This attempt's `?location=`, `?phone=` and `?client=`, resolved NOW: a
   * getter is asked on every attempt so a UI that changes one (a settings
   * field) is heard on the next reconnect without a remount. Trimmed; an empty
   * answer is none.
   */
  function report(): ClientReport {
    return {
      location: resolveReported(options.location),
      phone: resolveReported(options.phone),
      client: resolveReported(options.client),
    };
  }

  /**
   * The WebSocket URL and subprotocols for the *next* connection attempt.
   * Evaluated per attempt (partysocket takes async URL and protocol providers):
   *
   * - `GET client-config` is re-fetched every attempt. When it names a
   *   `sessionUrl` — the platform's broker pointing at the agent's live sandbox
   *   — the session connects DIRECTLY there. The URL changes when the sandbox is
   *   replaced (idle eviction, redeploy), which is exactly when a reconnect
   *   happens, so per-attempt brokering is what makes reconnects land on the
   *   replacement. Without one (`aai dev`, older servers), the same-origin
   *   `websocket` path is used.
   * - Once the first `config` arrives, every reconnect carries `?sessionId=<id>`
   *   and the server resumes the SAME session (id, tool state) instead of minting
   *   a new one. `resume=1` remains only as the greeting-suppression fallback for
   *   a server whose config carried no id.
   * - The session ticket (`session-core-ticket.ts`) is the `token` option's,
   *   asked for THIS attempt, else the `sessionToken` this attempt's
   *   `client-config` issued — to a lookup that presented the last one when
   *   the attempt resumes, so a broker binding tickets to sessions re-mints for
   *   the same session. A ticket bound to a session opens THAT session, so if
   *   the broker could not re-mint, the server starts a new one and its
   *   `config` frame says which.
   */
  async function resolveAttempt(): Promise<Attempt> {
    // Asked NOW, before the lookup, so a ticket fetch overlaps it — and on every
    // attempt, so a short-lived ticket is fresh on each reconnect.
    const ownToken = resolveSessionToken(options.token, { sessionId });
    // Known to say nothing per attempt: skip the fetch and go straight to the
    // same-origin path (the fetch could only return the same nothing again).
    const presented = sessionId === undefined ? undefined : serverTicket;
    const cfg =
      configPerAttempt === false
        ? null
        : await loadClientConfig(options.platformUrl, undefined, presented);
    // Only an ANSWERED lookup says anything about the server. A failed one (the
    // broker 503s while the sandbox boots, or a network blip) must not latch
    // `configPerAttempt = false`: that skips brokering on every later attempt and
    // pins the client to the platform's `/:slug/websocket` — browsers don't
    // follow its WebSocket redirect, so that route never recovers even after the
    // agent does. Only an answered lookup may latch.
    if (cfg) configPerAttempt = cfg.sessionUrl !== undefined || cfg.sessionToken !== undefined;
    // The caller's own ticket wins over one the server issued.
    const own = await ownToken;
    if (own === undefined && cfg?.sessionToken !== undefined) {
      serverTicket = cfg.sessionToken;
      writeStoredTicket(options.platformUrl, serverTicket);
    }
    const carriage = ticketCarriage(own ?? cfg?.sessionToken);
    const next = cfg?.sessionUrl
      ? buildBrokeredWsUrl(cfg.sessionUrl, hasConnected, sessionId, report())
      : buildWsUrl(options.platformUrl, hasConnected, sessionId, report());
    // The snapshot's `apiUrl` deliberately stays the long-living platform
    // endpoint set at construction — never the brokered sandbox tunnel URL,
    // which is ephemeral (dies on idle eviction/redeploy) and useless to share.
    return { url: withQueryToken(next, carriage), protocols: carriage.protocols };
  }

  /**
   * The attempt partysocket is dialling. It calls its URL and protocol providers
   * back to back for each attempt and awaits them together, so the URL provider
   * STARTS the attempt and the protocol provider reads that same one: a ticket
   * and the address it was fetched beside belong to one attempt.
   */
  let current: Promise<Attempt> | undefined;

  return {
    open: () => {
      if (options.WebSocket) {
        const carriage = ticketCarriage(resolveSessionTokenSync(options.token, { sessionId }));
        const target = withQueryToken(
          buildWsUrl(options.platformUrl, hasConnected, sessionId, report()),
          carriage,
        );
        return carriage.protocols
          ? new options.WebSocket(target, carriage.protocols)
          : new options.WebSocket(target);
      }
      // partysocket's reconnecting WebSocket — same interface, plus
      // reconnect-on-close, re-resolving the attempt per retry.
      return openReconnectingSocket(
        async () => {
          current = resolveAttempt();
          return (await current).url;
        },
        async () => (await (current ?? resolveAttempt())).protocols ?? null,
      );
    },
    configured: (sid) => {
      if (sid) {
        sessionId = sid;
        // Stored before any caller callback runs, so an `onSessionId` that throws
        // does not cost the next load its resume.
        writeStoredSessionId(options.platformUrl, sid);
      }
      hasConnected = true;
      confirm(sid);
    },
    adopt: (sid) => {
      sessionId = sid;
      writeStoredSessionId(options.platformUrl, sid);
      // Not "connected": this session has not handshaken on THIS core yet, and
      // the id alone is what makes the attempt a resume.
      hasConnected = false;
    },
    forget: () => {
      sessionId = undefined;
      // The STORED id goes too, or the next page load would rejoin the
      // conversation this call just discarded, greeting suppressed.
      clearStoredSessionId(options.platformUrl);
      // And its ticket: presenting it would re-mint for the discarded session.
      serverTicket = undefined;
      clearStoredTicket(options.platformUrl);
      hasConnected = false;
      confirm(undefined);
    },
    sessionId: () => confirmed,
  };
}
