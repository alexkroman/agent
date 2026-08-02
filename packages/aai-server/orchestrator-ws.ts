// Copyright 2025 the AAI authors. MIT license.
/**
 * WebSocket upgrade handling for the platform server.
 *
 * Split from orchestrator.ts (which owns the HTTP routes): upgrades bypass
 * Hono routing entirely, so everything here hangs off the Node server's
 * `upgrade` event.
 *
 * The ONLY session surface here is host mode (`?host=1`), which runs in the
 * server process on the agent's stored config and env (ws-host-mode.ts).
 * Plain client sessions do not pass through the platform host at all:
 * clients connect DIRECTLY to the agent's sandbox (its public `/websocket`
 * tunnel endpoint). `/:slug/websocket` is the LONG-LIVING programmatic
 * endpoint: a plain upgrade here resolves the agent's live sandbox (booting
 * it if needed, exactly like the `GET /:slug/client-config` broker) and
 * answers with a redirect to the sandbox's current session URL — never a
 * session. WebSocket clients that follow handshake redirects (`ws` with
 * `followRedirects`, websocat, most non-browser clients) land on the live
 * sandbox even as it is replaced across evictions and redeploys; browsers
 * don't follow WebSocket redirects, which is fine — the browser path is the
 * client-config broker.
 */

import { MAX_WS_PAYLOAD_BYTES, parseWsUpgradeParams } from "@alexkroman1/aai";
import type { SessionWebSocket } from "@alexkroman1/aai/runtime";
import { WebSocketServer } from "ws";
import { answerUpgrade } from "./_upgrade-reply.ts";
import type { AppDatabases } from "./app-database.ts";
import { MAX_CONNECTIONS } from "./constants.ts";
import type { SlugEpochs } from "./platform-epoch.ts";
import type { SandboxPool } from "./sandbox-pool.ts";
import { brokerSessionUrl } from "./sandbox-resolve.ts";
import type { SlotCache } from "./sandbox-slots.ts";
import { SLUG_PATTERN_SOURCE } from "./schemas.ts";
import type { SecretStore } from "./secret-store.ts";
import type { BundleStore } from "./store-types.ts";
import { guardHostModeUpgrade, startDeployedHostSession, wantsHostMode } from "./ws-host-mode.ts";

export type WsUpgradeOpts = {
  slots: SlotCache;
  store: BundleStore;
  /** Named secret storage — read for the app's `app-db:` credentials. */
  secrets?: SecretStore;
  /** Per-app database opener; absent when SUPABASE_DB_URL is unset. */
  appDb?: AppDatabases;
  /** Cross-replica invalidation epochs (see platform-epoch.ts). */
  slugEpochs?: SlugEpochs;
  /** Pre-warmed harness pool shared with the rest of the platform. */
  pool?: SandboxPool;
  /** Max concurrent WebSocket connections. Defaults to MAX_CONNECTIONS. */
  maxConnections?: number;
  /**
   * True once shutdown has begun. New upgrades are refused while draining so
   * the machine stops taking calls it is about to drop — see `_drain.ts`.
   * (Direct-to-sandbox client sessions are unaffected by a host drain.)
   */
  isDraining?: () => boolean;
};

export type WsUpgrades = {
  injectWebSocket: (server: import("node:http").Server) => void;
  /**
   * Close every live host-mode WebSocket (1001 "going away"). Graceful
   * shutdown calls this after the drain deadline — an HTTP server with open
   * WebSockets never finishes closing on its own.
   */
  closeActiveSockets: () => void;
  /** Live host-mode sockets. Shutdown polls this while draining. */
  activeSessionCount: () => number;
};

/**
 * Answer a plain (non-host) upgrade on the long-living `/:slug/websocket`
 * endpoint: resolve the agent's live sandbox — booting it on demand, exactly
 * like the `GET /:slug/client-config` broker — and redirect the handshake to
 * its current session URL, with the caller's query preserved so
 * `?sessionId=` resumes survive the hop. Clients that can't follow a
 * WebSocket redirect get the broker guidance in the body either way; an
 * unknown slug answers 404 and a sandbox that failed to start answers 503
 * (retryable) — the failure taxonomy is `brokerSessionUrl`, shared with the
 * client-config broker so the two can't drift.
 */
async function answerPlainUpgrade(
  rawUrl: string,
  slug: string,
  socket: import("node:stream").Duplex,
  opts: WsUpgradeOpts,
): Promise<void> {
  const brokered = await brokerSessionUrl(slug, {
    slots: opts.slots,
    store: opts.store,
    ...(opts.secrets && { secrets: opts.secrets }),
    ...(opts.appDb && { appDb: opts.appDb }),
    ...(opts.slugEpochs && { slugEpochs: opts.slugEpochs }),
    ...(opts.pool && { pool: opts.pool }),
  });
  const sessionUrl = brokered.ok ? brokered.sessionUrl : undefined;
  let status = "302 Found";
  if (!brokered.ok) {
    status = brokered.status === 404 ? "404 Not Found" : "503 Service Unavailable";
  }
  const extraHeaders: string[] = [];
  if (sessionUrl) {
    const location = new URL(sessionUrl);
    const qIdx = rawUrl.indexOf("?");
    if (qIdx !== -1) {
      for (const [k, v] of new URLSearchParams(rawUrl.slice(qIdx + 1))) {
        location.searchParams.set(k, v);
      }
    }
    extraHeaders.push(`Location: ${location}`);
  }
  const body = sessionUrl
    ? `sessions connect directly to the agent: follow the Location redirect, or GET /${slug}/client-config names the current sessionUrl\n`
    : `sessions connect directly to the agent: GET /${slug}/client-config names the current sessionUrl\n`;
  answerUpgrade(socket, status, body, extraHeaders);
}

export function createWsUpgrades(opts: WsUpgradeOpts): WsUpgrades {
  const maxConnections = opts.maxConnections ?? MAX_CONNECTIONS;
  let activeConnections = 0;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD_BYTES });

  // Enforced here (not just in middleware) because WebSocket upgrades bypass
  // Hono routing. Composed from the shared slug grammar (SLUG_PATTERN_SOURCE)
  // so the pattern has a single source of truth.
  const SLUG_WS_RE = new RegExp(`^\\/(${SLUG_PATTERN_SOURCE})\\/websocket$`);

  /**
   * Take a connection slot for this upgrade and wire its single release point.
   * Returns false (and destroys the socket) when the server is at capacity.
   */
  function acquireConnectionSlot(socket: {
    destroy: () => void;
    on: (event: "close", listener: () => void) => unknown;
  }): boolean {
    if (activeConnections >= maxConnections) {
      console.warn("WebSocket connection limit reached, rejecting upgrade");
      socket.destroy();
      return false;
    }
    activeConnections++;
    let released = false;
    socket.on("close", () => {
      if (released) return;
      released = true;
      activeConnections = Math.max(0, activeConnections - 1);
    });
    return true;
  }

  async function handleUpgradeRequest(
    req: import("node:http").IncomingMessage,
    socket: import("node:stream").Duplex,
    head: Buffer,
  ): Promise<void> {
    const rawUrl = req.url ?? "";
    const pathOnly = rawUrl.split("?")[0] ?? "";
    const slugMatch = pathOnly.match(SLUG_WS_RE);
    if (!slugMatch) {
      // No other upgrade consumer exists on this server: an unmatched
      // upgrade socket would otherwise dangle forever.
      socket.destroy();
      return;
    }
    const slug = slugMatch[1] as string;

    // Plain client sessions connect directly to the agent's sandbox — the
    // platform never terminates them. This path is the stable, long-living
    // programmatic endpoint: upgrade the caller to the sandbox's current
    // session URL via a handshake redirect. Answering the handshake (rather
    // than a bare RST) is what keeps failures diagnosable.
    if (!wantsHostMode(rawUrl)) {
      await answerPlainUpgrade(rawUrl, slug, socket, opts);
      return;
    }

    // Draining: this machine is being replaced, so starting a host session
    // here would only get it cut when the process exits.
    if (opts.isDraining?.()) {
      answerUpgrade(socket, "503 Service Unavailable", "server draining\n");
      return;
    }

    if (!acquireConnectionSlot(socket)) return;

    // Host mode lets the caller replace the agent's prompt and tools, so it
    // requires proving ownership of the slug. The guard answers and closes
    // the socket itself when it refuses. See ws-host-mode.ts.
    const mayProceed = await guardHostModeUpgrade({
      slug,
      headers: req.headers,
      store: opts.store,
      socket,
    });
    if (!mayProceed) return;

    // Host mode runs in the server process on the agent's stored config and
    // env — it never touches the sandbox. A missing config means the agent
    // can't run: answer with a close frame instead of a dangling socket.
    const agentConfig = await opts.store.getAgentConfig(slug);
    wss.handleUpgrade(req, socket, head, (ws) => {
      const sessionWs = ws as unknown as SessionWebSocket;
      // `ws` sockets are EventEmitters: an `error` with no listener throws.
      (ws as { on: (ev: string, fn: () => void) => void }).on("error", () => undefined);
      if (!agentConfig) {
        sessionWs.close?.(1011, "agent unavailable");
        return;
      }
      try {
        startDeployedHostSession(sessionWs, {
          slug,
          agentConfig,
          store: opts.store,
          startOpts: parseWsUpgradeParams(rawUrl),
        });
      } catch (err: unknown) {
        console.error("WebSocket host-session start error:", err);
        ws.close(1011, "internal error");
      }
    });
  }

  const injectWebSocket = (server: import("node:http").Server) => {
    server.on("upgrade", (req, socket, head) => {
      // Node removes its own socket error listener before emitting `upgrade`;
      // without one, a client RST during the async guard becomes an
      // unhandled `error` → uncaughtException → the whole host exits. Attach
      // before ANY early return so unmatched upgrade sockets are covered too.
      socket.on("error", () => {
        /* handled via close/destroy below; presence prevents an uncaught throw */
      });

      void handleUpgradeRequest(req, socket, head).catch((err: unknown) => {
        console.error("WebSocket upgrade error:", err);
        answerUpgrade(socket, "500 Internal Server Error", "internal error\n");
      });
    });
  };

  const closeActiveSockets = () => {
    for (const client of wss.clients) {
      client.close(1001, "server shutting down");
    }
  };

  return { injectWebSocket, closeActiveSockets, activeSessionCount: () => wss.clients.size };
}
