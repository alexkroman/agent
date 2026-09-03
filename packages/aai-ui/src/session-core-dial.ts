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
import { openReconnectingSocket } from "./session-core-reconnect.ts";
import { buildBrokeredWsUrl, buildWsUrl } from "./session-core-url.ts";
import {
  clearStoredSessionId,
  readStoredSessionId,
  writeStoredSessionId,
} from "./session-resume-store.ts";
import type { WebSocketConstructor } from "./types.ts";

/** What the dialer needs from the session's options. */
export type DialOptions = {
  platformUrl: string;
  /** Tests inject one; it connects to the same-origin path and never reconnects. */
  WebSocket?: WebSocketConstructor | undefined;
  /** An id the caller manages itself — wins over what a previous load stored. */
  resumeSessionId?: string | undefined;
};

export type Dialer = {
  /** The URL for the next attempt — partysocket's async provider. */
  url(): Promise<string>;
  /** A socket for this attempt. */
  open(): InstanceType<WebSocketConstructor>;
  /**
   * A completed handshake: adopt the server's session id and record that this
   * connection has been established, so every later attempt resumes.
   */
  configured(sid: string | undefined): void;
  /** Drop the resume identity, so the next connect is a NEW session. */
  forget(): void;
};

/** @internal */
export function createDialer(options: DialOptions): Dialer {
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
   * Whether `platformUrl` is a broker (its `client-config` names a
   * `sessionUrl`). A server is one or it isn't — it never flips mid-session — so
   * once a non-broker is observed, later reconnects skip the `client-config`
   * re-fetch that would only fall through to `buildWsUrl` (every reconnect on
   * `aai dev` / self-hosted otherwise pays a wasted GET). `undefined` until the
   * first fetch settles.
   */
  let serverIsBroker: boolean | undefined;

  /**
   * The WebSocket URL for the *next* connection attempt. Evaluated per attempt
   * (partysocket takes it as an async URL provider):
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
   */
  async function url(): Promise<string> {
    // Known non-broker: skip the fetch and go straight to the same-origin path
    // (the fetch could only return no `sessionUrl` again).
    const cfg = serverIsBroker === false ? null : await loadClientConfig(options.platformUrl);
    // Only an ANSWERED lookup says anything about the server. A failed one (the
    // broker 503s while the sandbox boots, or a network blip) must not latch
    // `serverIsBroker = false`: that skips brokering on every later attempt and
    // pins the client to the platform's `/:slug/websocket` — browsers don't
    // follow its WebSocket redirect, so that route never recovers even after the
    // agent does. Only an answered lookup may latch.
    if (cfg) serverIsBroker = cfg.sessionUrl !== undefined;
    const next = cfg?.sessionUrl
      ? buildBrokeredWsUrl(cfg.sessionUrl, hasConnected, sessionId)
      : buildWsUrl(options.platformUrl, hasConnected, sessionId);
    // The snapshot's `apiUrl` deliberately stays the long-living platform
    // endpoint set at construction — never the brokered sandbox tunnel URL,
    // which is ephemeral (dies on idle eviction/redeploy) and useless to share.
    return next.toString();
  }

  return {
    url,
    open: () => {
      if (options.WebSocket) {
        return new options.WebSocket(
          buildWsUrl(options.platformUrl, hasConnected, sessionId).toString(),
        );
      }
      // partysocket's reconnecting WebSocket — same interface, plus
      // reconnect-on-close, re-reading `url` per attempt.
      return openReconnectingSocket(url);
    },
    configured: (sid) => {
      if (sid) {
        sessionId = sid;
        // Stored before any caller callback runs, so an `onSessionId` that throws
        // does not cost the next load its resume.
        writeStoredSessionId(options.platformUrl, sid);
      }
      hasConnected = true;
    },
    forget: () => {
      sessionId = undefined;
      // The STORED id goes too, or the next page load would rejoin the
      // conversation this call just discarded, greeting suppressed.
      clearStoredSessionId(options.platformUrl);
      hasConnected = false;
    },
  };
}
