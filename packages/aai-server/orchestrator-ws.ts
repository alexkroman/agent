// Copyright 2025 the AAI authors. MIT license.
/**
 * WebSocket upgrade handling for the platform server.
 *
 * Split from orchestrator.ts (which owns the HTTP routes): upgrades bypass
 * Hono routing entirely, so everything here hangs off the Node server's
 * `upgrade` event — slug matching, the connection cap, the host-mode
 * ownership gate, sandbox resolution, and session lifecycle metrics.
 */

import { MAX_WS_PAYLOAD_BYTES, parseWsUpgradeParams } from "@alexkroman1/aai";
import type { SessionWebSocket } from "@alexkroman1/aai/runtime";
import { WebSocketServer } from "ws";
import { MAX_CONNECTIONS } from "./constants.ts";
import {
  hrtimeSeconds,
  metrics,
  type SessionEndReason,
  type SessionErrorKind,
  type SessionMode,
} from "./metrics.ts";
import type { IsolateConfig } from "./rpc-schemas.ts";
import { resolveSandbox } from "./sandbox.ts";
import { acquireSlotSession, releaseSlotSession, type SlotCache } from "./sandbox-slots.ts";
import { VALID_SLUG_RE } from "./schemas.ts";
import type { BundleStore } from "./store-types.ts";
import { guardHostModeUpgrade, startDeployedHostSession, wantsHostMode } from "./ws-host-mode.ts";

export type WsUpgradeOpts = {
  slots: SlotCache;
  store: BundleStore;
  /** Options forwarded to resolveSandbox for plain (non-host) sessions. */
  sandboxOpts: Parameters<typeof resolveSandbox>[1];
  /** Max concurrent WebSocket connections. Defaults to MAX_CONNECTIONS. */
  maxConnections?: number;
};

export type WsUpgrades = {
  injectWebSocket: (server: import("node:http").Server) => void;
  /**
   * Close every live session WebSocket (1001 "going away"). Graceful
   * shutdown calls this before `server.close()` — an HTTP server with open
   * WebSockets never finishes closing on its own.
   */
  closeActiveSockets: () => void;
};

export function createWsUpgrades(opts: WsUpgradeOpts): WsUpgrades {
  const maxConnections = opts.maxConnections ?? MAX_CONNECTIONS;
  let activeConnections = 0;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD_BYTES });

  // Enforced here (not just in middleware) because WebSocket upgrades bypass
  // Hono routing. Derived from VALID_SLUG_RE (anchors stripped) so the slug
  // pattern has a single source of truth.
  const SLUG_WS_RE = new RegExp(`^\\/(${VALID_SLUG_RE.source.slice(1, -1)})\\/websocket$`);

  async function resolveUpgrade(slug: string) {
    const [sandbox, agentConfig] = await Promise.all([
      resolveSandbox(slug, opts.sandboxOpts),
      opts.store.getAgentConfig(slug),
    ]);
    if (!sandbox) return null;
    return { sandbox, agentConfig };
  }

  /**
   * Take a connection slot for this upgrade and wire its single release point.
   * Returns false (and destroys the socket) when the server is at capacity.
   *
   * The raw socket's `close` fires in every outcome — client abort during the
   * async resolve (where handleUpgrade would otherwise destroy the socket
   * without invoking its callback, leaking the slot forever), a failed
   * upgrade, or a normal session end — so it is the one reliable place to
   * release.
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

  /**
   * Resolve the agent and hand the socket to the session, or destroy it.
   * Split out of the upgrade handler so each stays under the complexity cap.
   */
  async function completeUpgrade(
    req: import("node:http").IncomingMessage,
    socket: import("node:stream").Duplex,
    head: Buffer,
    ctx: { slug: string; rawUrl: string; hostMode: boolean },
  ): Promise<void> {
    const { slug, rawUrl, hostMode } = ctx;
    try {
      let sandbox: Awaited<ReturnType<typeof resolveSandbox>> = null;
      let agentConfig: IsolateConfig | null = null;
      if (hostMode) {
        // Host mode runs in the server process on the agent's stored config
        // and env (ws-host-mode.ts) — it never touches the sandbox. Don't
        // cold-spawn one it won't use, and don't require worker code to
        // exist: config + env are all a host session needs.
        agentConfig = await opts.store.getAgentConfig(slug);
      } else {
        const result = await resolveUpgrade(slug);
        if (!result) {
          socket.destroy();
          return;
        }
        sandbox = result.sandbox;
        agentConfig = result.agentConfig;
      }
      const mode: SessionMode = agentConfig?.mode === "pipeline" ? "pipeline" : "s2s";
      wss.handleUpgrade(req, socket, head, (ws) => {
        // This callback runs after completeUpgrade's own try/catch has already
        // passed — a failure here (slot acquisition, session start) would
        // otherwise be an unhandled rejection. Close the ws instead; its
        // `close` event releases the connection slot and any acquired slot
        // session.
        onSessionSocket(ws as unknown as SessionWebSocket, {
          slug,
          mode,
          sandbox,
          agentConfig,
          hostMode,
          rawUrl,
        }).catch((err: unknown) => {
          console.error("WebSocket session start error:", err);
          ws.close(1011, "internal error");
        });
      });
    } catch (err: unknown) {
      console.error("WebSocket open error:", err);
      socket.destroy();
    }
  }

  /**
   * Wire metrics and start the session once the socket is upgraded. Extracted
   * from the upgrade handler so neither piece trips the complexity cap.
   */
  async function onSessionSocket(
    ws: SessionWebSocket,
    ctx: {
      slug: string;
      mode: SessionMode;
      sandbox: Awaited<ReturnType<typeof resolveSandbox>>;
      agentConfig: IsolateConfig | null;
      hostMode: boolean;
      rawUrl: string;
    },
  ): Promise<void> {
    const { slug, mode, agentConfig, hostMode, rawUrl } = ctx;
    let { sandbox } = ctx;
    metrics.sessionsStarted.inc({ slug, mode });
    metrics.sessionsActive.inc({ slug });
    // Assigned after the re-resolve below; the close listener is attached
    // first so a socket that dies during the await still runs the metrics
    // path (releasing a null handle is a no-op).
    let sessionSlot: ReturnType<typeof acquireSlotSession> = null;
    let closed = false;
    const startedAt = process.hrtime.bigint();
    const socket = ws as unknown as {
      on: (event: string, fn: (arg: number) => void) => void;
    };
    socket.on("close", (code: number) => {
      closed = true;
      releaseSlotSession(opts.slots, sessionSlot);
      metrics.sessionDuration.observe(hrtimeSeconds(startedAt));
      metrics.sessionsActive.dec({ slug });
      const reason: SessionEndReason =
        code === 1000 || code === 1001 ? "client_close" : "server_close";
      metrics.sessionsEnded.inc({ slug, reason });
    });
    socket.on("error", () => {
      const kind: SessionErrorKind = "internal";
      metrics.sessionErrors.inc({ kind });
    });
    if (hostMode) {
      // Ownership was already proven at the upgrade (guardHostModeUpgrade).
      // A host session needs only the stored config + env — no sandbox, and
      // no slot-session pin (there is no sandbox to protect from idle
      // eviction). A missing config means the agent can't run: answer with
      // a close frame instead of silently falling back to a plain session
      // that would ignore the owner's overrides.
      if (!agentConfig) {
        ws.close?.(1011, "agent unavailable");
        return;
      }
      startDeployedHostSession(ws, {
        slug,
        agentConfig,
        store: opts.store,
        startOpts: parseWsUpgradeParams(rawUrl),
      });
      return;
    }
    // The sandbox resolved at upgrade time can be shut down (idle eviction,
    // deploy/delete) before the handshake completes; starting a session on it
    // would be use-after-teardown. When the slot no longer holds it,
    // re-resolve once (or fail the session cleanly below).
    if (opts.slots.get(slug)?.sandbox !== sandbox) {
      sandbox = await resolveSandbox(slug, opts.sandboxOpts).catch(() => null);
    }
    // Track the live session so idle eviction can't kill the sandbox mid-call
    // (a session can outlive IDLE_SANDBOX_MS). The returned handle pins the
    // specific slot object — a redeploy replaces the slot, and releasing by
    // slug would decrement the replacement's counter.
    if (closed) return;
    sessionSlot = acquireSlotSession(opts.slots, slug);
    if (!sandbox) {
      // Agent was deleted (or its sandbox can't be rebuilt) between upgrade
      // and handshake — answer with a close frame, not a dangling socket.
      ws.close?.(1011, "agent unavailable");
      return;
    }
    sandbox.startSession(ws, parseWsUpgradeParams(rawUrl));
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

    if (!acquireConnectionSlot(socket)) return;

    // Host mode lets the caller replace the agent's prompt and tools, so it
    // requires proving ownership of the slug — unlike a plain connection,
    // which stays unauthenticated. The guard answers and closes the socket
    // itself when it refuses. See ws-host-mode.ts.
    const hostMode = wantsHostMode(rawUrl);
    const mayProceed = await guardHostModeUpgrade({
      rawUrl,
      slug,
      headers: req.headers,
      store: opts.store,
      socket,
    });
    if (!mayProceed) return;

    await completeUpgrade(req, socket, head, { slug, rawUrl, hostMode });
  }

  const injectWebSocket = (server: import("node:http").Server) => {
    server.on("upgrade", (req, socket, head) => {
      // Node removes its own socket error listener before emitting `upgrade`;
      // without one, a client RST during the async resolve becomes an
      // unhandled `error` → uncaughtException → the whole host exits. Attach
      // before ANY early return so unmatched upgrade sockets are covered too.
      socket.on("error", () => {
        /* handled via close/destroy below; presence prevents an uncaught throw */
      });

      // A rejection anywhere in the async path (e.g. a storage blip inside
      // guardHostModeUpgrade) would otherwise be an unhandledRejection that
      // strands the socket. Answer the handshake — same pattern as
      // guardHostModeUpgrade's refusal — then destroy.
      void handleUpgradeRequest(req, socket, head).catch((err: unknown) => {
        console.error("WebSocket upgrade error:", err);
        try {
          socket.write(
            "HTTP/1.1 500 Internal Server Error\r\n" +
              "Connection: close\r\n" +
              "Content-Type: text/plain\r\n\r\n" +
              "internal error\n",
          );
        } catch {
          // Socket already gone — destroy below is all that's left.
        }
        socket.destroy();
      });
    });
  };

  const closeActiveSockets = () => {
    for (const client of wss.clients) {
      client.close(1001, "server shutting down");
    }
  };

  return { injectWebSocket, closeActiveSockets };
}
