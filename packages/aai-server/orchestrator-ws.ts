// Copyright 2025 the AAI authors. MIT license.
/**
 * WebSocket upgrade handling for the platform server.
 *
 * Split from orchestrator.ts (which owns the HTTP routes): upgrades bypass
 * Hono routing entirely, so everything here hangs off the Node server's
 * `upgrade` event.
 *
 * The platform terminates NO sessions. Clients connect DIRECTLY to the
 * agent's sandbox (its public `/websocket` tunnel endpoint);
 * `/:slug/websocket` is the LONG-LIVING programmatic endpoint: an upgrade
 * here resolves the agent's live sandbox (booting it if needed, exactly like
 * the `GET /:slug/client-config` broker) and answers with a redirect to the
 * sandbox's current session URL — never a session. WebSocket clients that
 * follow handshake redirects (`ws` with `followRedirects`, websocat, most
 * non-browser clients) land on the live sandbox even as it is replaced
 * across evictions and redeploys; browsers don't follow WebSocket redirects,
 * which is fine — the browser path is the client-config broker.
 *
 * (Platform host mode — `?host=1` sessions running in the server process on
 * the agent's stored config — was removed: it was the one path where the
 * SERVER's SDK interpreted stored configs, a cross-version seam for deployed
 * bundles. Host mode remains an `aai dev` feature.)
 */

import { requestPath, requestQuery } from "@alexkroman1/aai/internal";
import { answerUpgrade } from "./_upgrade-reply.ts";
import { brokerSessionUrl } from "./sandbox-broker.ts";
import type { ResolveSandboxOpts } from "./sandbox-resolve.ts";
import { SLUG_PATTERN_SOURCE } from "./schemas.ts";

/**
 * The upgrade path grammar: `/<slug>/websocket`.
 *
 * Enforced here (not just in middleware) because WebSocket upgrades bypass
 * Hono routing. Composed from the shared slug grammar (SLUG_PATTERN_SOURCE)
 * so the pattern has a single source of truth.
 *
 * Exported at module scope so a spec can bind to the PRODUCTION regex rather
 * than recomposing it: a recomposed copy passes whether or not this one still
 * exists, which is the failure `orchestrator-security-validation.test.ts`
 * exists to catch.
 */
export const SLUG_WS_RE = new RegExp(`^\\/(${SLUG_PATTERN_SOURCE})\\/websocket$`);

/**
 * The slug an upgrade path names, or `undefined` when the path is not a
 * well-formed `/<slug>/websocket`.
 */
export function wsSlugFromPath(pathOnly: string): string | undefined {
  return SLUG_WS_RE.exec(pathOnly)?.[1];
}

export type WsUpgradeOpts = {
  /**
   * Broker dependencies, the same object the `GET /:slug/client-config`
   * route uses — assembled once in the orchestrator so a new broker
   * dependency is one edit, not one per consumer.
   */
  broker: ResolveSandboxOpts;
};

export type WsUpgrades = {
  injectWebSocket: (server: import("node:http").Server) => void;
};

/**
 * Answer an upgrade on the long-living `/:slug/websocket` endpoint: resolve
 * the agent's live sandbox — booting it on demand, exactly like the
 * `GET /:slug/client-config` broker — and redirect the handshake to its
 * current session URL, with the caller's query preserved so `?sessionId=`
 * resumes survive the hop. Clients that can't follow a WebSocket redirect
 * get the broker guidance in the body either way; an unknown slug answers
 * 404 and a sandbox that failed to start answers 503 (retryable) — the
 * failure taxonomy is `brokerSessionUrl`, shared with the client-config
 * broker so the two can't drift.
 */
async function answerRedirectUpgrade(
  rawUrl: string,
  slug: string,
  socket: import("node:stream").Duplex,
  opts: WsUpgradeOpts,
): Promise<void> {
  const brokered = await brokerSessionUrl(slug, opts.broker);
  const sessionUrl = brokered.ok ? brokered.sessionUrl : undefined;
  let status = "302 Found";
  if (!brokered.ok) {
    status = brokered.status === 404 ? "404 Not Found" : "503 Service Unavailable";
  }
  const extraHeaders: string[] = [];
  if (sessionUrl) {
    const location = new URL(sessionUrl);
    for (const [k, v] of requestQuery(rawUrl)) {
      location.searchParams.set(k, v);
    }
    extraHeaders.push(`Location: ${location}`);
  }
  const body = sessionUrl
    ? `sessions connect directly to the agent: follow the Location redirect, or GET /${slug}/client-config names the current sessionUrl\n`
    : `sessions connect directly to the agent: GET /${slug}/client-config names the current sessionUrl\n`;
  answerUpgrade(socket, status, body, extraHeaders);
}

export function createWsUpgrades(opts: WsUpgradeOpts): WsUpgrades {
  async function handleUpgradeRequest(
    req: import("node:http").IncomingMessage,
    socket: import("node:stream").Duplex,
  ): Promise<void> {
    const rawUrl = req.url ?? "";
    const pathOnly = requestPath(rawUrl);
    const slug = wsSlugFromPath(pathOnly);
    if (slug === undefined) {
      // No other upgrade consumer exists on this server: an unmatched
      // upgrade socket would otherwise dangle forever.
      socket.destroy();
      return;
    }
    // Every upgrade is answered with a handshake response (redirect or a
    // real error status), never a completed session. Answering the handshake
    // (rather than a bare RST) is what keeps failures diagnosable.
    await answerRedirectUpgrade(rawUrl, slug, socket, opts);
  }

  const injectWebSocket = (server: import("node:http").Server) => {
    server.on("upgrade", (req, socket, _head) => {
      // Node removes its own socket error listener before emitting `upgrade`;
      // without one, a client RST during the async broker call becomes an
      // unhandled `error` → uncaughtException → the whole host exits. Attach
      // before ANY early return so unmatched upgrade sockets are covered too.
      socket.on("error", () => {
        /* handled via close/destroy below; presence prevents an uncaught throw */
      });

      void handleUpgradeRequest(req, socket).catch((err: unknown) => {
        console.error("WebSocket upgrade error:", err);
        answerUpgrade(socket, "500 Internal Server Error", "internal error\n");
      });
    });
  };

  return { injectWebSocket };
}
