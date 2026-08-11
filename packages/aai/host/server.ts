// Copyright 2025 the AAI authors. MIT license.
/**
 * Self-hosted agent HTTP + WebSocket server.
 *
 * {@link createServer} wraps a runtime from `createRuntime` with an
 * HTTP + WebSocket server using only `node:http` and `ws` (no framework
 * dependencies) — the same server `aai dev` runs. Use it to host an agent on
 * your own infrastructure instead of the managed platform: see
 * `examples/self-hosted-server` for a runnable setup.
 *
 * Import via `@alexkroman1/aai/runtime`.
 */

import http from "node:http";
import escapeHtml from "escape-html";
import { WebSocketServer } from "ws";
import { buildClientConfig, CLIENT_CONFIG_PATH } from "../sdk/client-config.ts";
import { AGENT_CSP, MAX_WS_PAYLOAD_BYTES } from "../sdk/constants.ts";
import { omitUndefined } from "../sdk/omit-undefined.ts";
import type { AgentDef } from "../sdk/types.ts";
import { errorMessage } from "../sdk/utils.ts";
import { parseWsUpgradeParams } from "../sdk/ws-upgrade.ts";
import type { Logger } from "./runtime-config.ts";
import { consoleLogger } from "./runtime-config.ts";
import type { AgentRuntime } from "./runtime-types.ts";
import { serveStatic } from "./server-static.ts";
import {
  decliningRuntime,
  STATIC_PAGE_REFUSAL,
  startOrRefuseHostSession,
} from "./server-upgrade.ts";
import { handleTelephonyUpgrade } from "./telephony/telephony-server.ts";
import { createWorkflowApi, WORKFLOW_API_TOKEN_ENV } from "./workflow-api.ts";
import { asSessionWebSocket } from "./ws-handler.ts";

/**
 * The session-facing slice of a runtime — all {@link createServer} needs.
 * A runtime built with `createRuntime` satisfies it directly.
 *
 * Narrowed to these two methods (rather than demanding a full
 * `AgentRuntime`) so an embedder can supply a lazily-built runtime facade.
 */
export type SessionRuntime = Pick<AgentRuntime, "startSession" | "shutdown" | "workflows">;

// Re-exported from its own module so `@alexkroman1/aai/runtime` and existing
// importers are unchanged by the split.
export { decliningRuntime } from "./server-upgrade.ts";

/** Configuration for {@link createServer}. */
/**
 * The options every front door over {@link createServer} passes straight
 * through — a logger and the two request hooks.
 *
 * Shared rather than restated because {@link createAgentServer} and
 * `createHostServer` are wrappers, not alternative APIs: a hook added here has
 * to reach both, and three identically-documented fields copied into each is
 * how one of them silently stops offering it.
 */
export type PassthroughServerOptions = {
  /** Structured logger. Defaults to the console logger. */
  logger?: Logger;
  /** First look at every WebSocket upgrade — see {@link ServerOptions.upgrade}. */
  upgrade?: ServerOptions["upgrade"];
  /** First look at every HTTP request — see {@link ServerOptions.request}. */
  request?: ServerOptions["request"];
};

export type ServerOptions = {
  /** The runtime sessions are started on — see `createRuntime`. */
  runtime: SessionRuntime;
  /** Display name served by `GET /client-config`. Defaults to `"agent"`. */
  name?: string;
  /** Directory of static client assets to serve at `/`. */
  clientDir?: string;
  /** Structured logger. Defaults to the console logger. */
  logger?: Logger;
  /**
   * Environment for host-mode connections (a `?host=1` WebSocket whose first
   * `config` frame supplies its own agent) and the source of secrets for the
   * per-connection runtime.
   *
   * Supplying `env` does not by itself enable host mode: it is opt-in via
   * `AAI_ALLOW_HOST` (see `isHostAllowed`). Omitting `env` disables host mode
   * unconditionally — any `?host=1` connection is rejected.
   *
   * It need not carry provider credentials at all: a client may bring its own
   * in the handshake's `credentials` block, which wins over anything here for
   * that connection. A server holding only `AAI_ALLOW_HOST` is the multi-tenant
   * shape — every session runs on the caller's key, so an unauthenticated
   * client has no operator credential to spend. See `examples/host-server`.
   */
  env?: Record<string, string>;
  /**
   * The deployed agent. Host-mode sessions inherit its `stt`/`llm`/`tts`
   * provider config so they run the operator's configured pipeline instead of
   * the default S2S path. Only prompt/greeting/tools come from the client.
   */
  hostBaseAgent?: AgentDef;
  /** Agent greeting, included in the `GET /client-config` response. */
  greeting?: string;
  /**
   * First look at every WebSocket upgrade. Return true to claim it (the
   * server then leaves the socket alone); return false to fall through to
   * the standard `/websocket` session handling. Lets an embedder (the
   * platform's guest harness) add its own upgrade surface — its host
   * control channel — without a second HTTP server.
   */
  upgrade?: (
    req: http.IncomingMessage,
    socket: import("node:stream").Duplex,
    head: Buffer,
  ) => boolean;
  /**
   * First look at every HTTP request (after `/health`). Return true to claim
   * it — the server then leaves the response alone. The `upgrade` hook's
   * HTTP twin: lets an embedder (the platform's guest harness) add its own
   * HTTP surface — the studio coding agent's chat endpoint — without a
   * second HTTP server.
   */
  request?: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: string,
    method: string,
  ) => boolean;
  /**
   * Serve carrier media streams on `WS /phone` (Twilio, Telnyx — see
   * `telephony/carriers.ts`). Defaults to true.
   *
   * On by default because it grants exactly what `/websocket` beside it
   * already grants — the same session, agent and credentials — so it is not
   * the kind of surface the loopback bind and the host-mode flag are
   * fail-closed about. Set false to remove the route.
   */
  telephony?: boolean;
  /**
   * What this server's page IS — see `AgentDef.page`. Defaults to `"voice"`.
   *
   * `"static"` REFUSES both voice surfaces instead of leaving them listening: a
   * static app declares no STT/LLM/TTS, so a session it accepted is one it could
   * not serve. It is passed here rather than read off an agent because
   * {@link SessionRuntime} is deliberately narrowed (see `createAgentServer`).
   */
  page?: "voice" | "static";
};

/** Handle returned by {@link createServer}. */
export type AgentServer = {
  /**
   * Start listening. `host` defaults to {@link DEFAULT_LISTEN_HOST} (loopback)
   * — pass `"0.0.0.0"` to deliberately expose the server on other interfaces.
   */
  listen(port?: number, host?: string): Promise<void>;
  close(): Promise<void>;
  port: number | undefined;
};

/**
 * Default bind address. Loopback, not every interface: this server has no
 * request authentication of its own, so binding `0.0.0.0` by default put a
 * developer's agent — and the provider credentials backing it — in reach of
 * anyone on the same network (a shared office or cafe LAN). Exposing it is now
 * an explicit choice by the caller.
 */
export const DEFAULT_LISTEN_HOST = "127.0.0.1";

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

/**
 * How often shutdown re-drops idle keep-alive connections — see `close()`.
 * Short enough to be invisible next to a process exit, long enough that the
 * timer costs nothing on a shutdown that finishes immediately.
 */
const IDLE_SWEEP_MS = 25;

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

/**
 * Create an HTTP + WebSocket server for an agent — the self-hosting entry
 * point, and the same server `aai dev` runs.
 *
 * Serves `GET /health`, `GET /client-config` (name/greeting for the browser
 * client), static client assets when `clientDir` is set, and voice sessions
 * on `WS /websocket`. {@link AgentServer.listen} binds loopback by default;
 * pass `"0.0.0.0"` to expose it deliberately (the server has no request
 * authentication of its own).
 *
 * @example
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 * import { createRuntime, createServer } from "@alexkroman1/aai/runtime";
 *
 * const myAgent = agent({ name: "Support", systemPrompt: "…" });
 * const runtime = createRuntime({
 *   agent: myAgent,
 *   env: { ASSEMBLYAI_API_KEY: process.env.ASSEMBLYAI_API_KEY ?? "" },
 * });
 * const server = createServer({ runtime, name: myAgent.name });
 * await server.listen(3000);
 * ```
 *
 * @public
 */
export function createServer(options: ServerOptions): AgentServer {
  const { runtime, clientDir, logger = consoleLogger, env, hostBaseAgent } = options;
  const name = options.name ?? "agent";
  const isStatic = options.page === "static";

  const defaultHtml = `<!DOCTYPE html><html><body><h1>${escapeHtml(name)}</h1><p>Agent server running.</p></body></html>`;

  const workflowApi = createWorkflowApi({
    // Read off the RUNTIME, per request. `SessionRuntime` is already the lazy
    // seam — the guest harness supplies a facade that builds its runtime on
    // first use — so a second `workflows` option would have been a parallel
    // channel for the same thing, and two channels can disagree about which
    // engine this server is serving.
    engine: () => runtime.workflows,
    ...omitUndefined({ token: env?.[WORKFLOW_API_TOKEN_ENV] }),
    logger,
  });

  // Pre-connection client config: how the default client should talk to
  // this agent (see sdk/client-config.ts).
  function sendClientConfig(res: http.ServerResponse): void {
    sendJson(res, 200, buildClientConfig({ name, greeting: options.greeting }));
  }

  async function handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: string,
    method: string,
  ): Promise<void> {
    // Registered before static serving so a client asset can never shadow
    // the client-config endpoint.
    if (method === "GET" && url === `/${CLIENT_CONFIG_PATH}`) {
      sendClientConfig(res);
      return;
    }

    // Also before static serving, and for the same reason: a client asset must
    // not be able to shadow an API route. The embedder's own `request` hook
    // still runs ahead of both (the guest's studio surface).
    if (workflowApi(req, res, url, method)) return;

    if (clientDir && (await serveStatic(clientDir, req, res, logger))) return;

    if (method === "GET" && url === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(defaultHtml);
      return;
    }

    logger.error(`${method} ${url} 404`);
    sendJson(res, 404, { error: "Not found" });
  }

  const httpServer = http.createServer((req, res) => {
    const url = req.url?.split("?")[0] ?? "/";
    const method = req.method ?? "GET";

    res.setHeader("Content-Security-Policy", AGENT_CSP);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");

    if (method === "GET" && url === "/health") {
      sendJson(res, 200, { status: "ok", name });
      return;
    }
    if (options.request?.(req, res, url, method)) return;
    handleRequest(req, res, url, method).catch((err: unknown) => {
      // A rejection here would otherwise be an unhandled rejection that can
      // take down the process; answer 500 when possible, else drop the socket.
      logger.error("Request handler failed", { error: errorMessage(err) });
      try {
        if (res.headersSent) {
          res.destroy();
        } else {
          sendJson(res, 500, { error: "Internal server error" });
        }
      } catch {
        res.destroy();
      }
    });
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD_BYTES });

  httpServer.on("upgrade", (req, socket, head) => {
    // Node removes its own socket error listener before emitting `upgrade`;
    // without one, a client RST before ws attaches its handler becomes an
    // unhandled `error` → uncaughtException that can take down the host.
    socket.on("error", () => {
      /* surfaced via close; presence prevents an uncaught throw */
    });

    if (options.upgrade?.(req, socket, head)) return;

    const url = req.url?.split("?")[0] ?? "";
    // A static page declares no STT/LLM/TTS, so telephony defaults OFF for one —
    // but as a default, not a veto: `?? ` leaves an explicit `telephony: true`
    // honoured rather than silently discarded by another option. Refusing on
    // `/websocket` SAYS so (below); a carrier has nothing to read a refusal
    // from, so for it the route simply is not there.
    const telephony = options.telephony ?? !isStatic;
    if (handleTelephonyUpgrade({ req, socket, head, wss, runtime, logger, enabled: telephony })) {
      return;
    }
    if (!url.startsWith("/websocket")) {
      // No other upgrade consumer exists on this server: an unmatched upgrade
      // socket would otherwise dangle forever with no error handling.
      socket.destroy();
      return;
    }

    const params = new URLSearchParams((req.url ?? "").split("?")[1] ?? "");
    const wantsHost = params.has("host");

    wss.handleUpgrade(req, socket, head, (ws) => {
      const startOpts = parseWsUpgradeParams(req.url ?? "");
      const session = asSessionWebSocket(ws);

      // Static page: the socket is completed and then declined WITH A REASON,
      // rather than destroyed at the upgrade. A client that dialed here is a
      // voice client pointed at an app that has no voice — and a bare failed
      // upgrade sends it into its reconnect backoff against a server that will
      // never answer, with nothing in the frame log saying why.
      if (isStatic) {
        logger.warn(`WS upgrade ${url} rejected: this agent serves a static page`);
        decliningRuntime(STATIC_PAGE_REFUSAL, logger).startSession(session);
        return;
      }

      if (wantsHost) {
        startOrRefuseHostSession(session, { env, hostBaseAgent, startOpts, logger, url });
        return;
      }

      logger.info(`WS upgrade ${url}${startOpts.skipGreeting ? " (resume)" : ""}`);
      runtime.startSession(session, startOpts);
    });
  });

  let listenPort: number | undefined;

  // Post-listen server errors have no promise to reject into (listen()'s
  // one-shot reject is removed once bound) — log instead of crashing on an
  // unhandled 'error' event.
  httpServer.on("error", (err) => {
    logger.error("HTTP server error", { error: errorMessage(err) });
  });

  return {
    get port() {
      return listenPort;
    },

    async listen(port = 3000, host = DEFAULT_LISTEN_HOST) {
      await new Promise<void>((resolve, reject) => {
        // `once` + removal on success: a persistent reject here would pile up
        // one listener per listen() call and reject a long-settled promise.
        httpServer.once("error", reject);
        httpServer.listen(port, host, () => {
          httpServer.removeListener("error", reject);
          const addr = httpServer.address();
          listenPort = typeof addr === "object" && addr ? addr.port : port;
          resolve();
        });
      });
    },

    async close() {
      try {
        await runtime.shutdown();
      } finally {
        try {
          // runtime.shutdown() closes the provider transports but not the
          // client sockets, and wss.close() on a noServer WebSocketServer does
          // not terminate existing connections. Without this, httpServer.close()
          // waits forever for an upgraded client socket to end (dev/CLI shutdown
          // hangs whenever a browser tab is still connected).
          for (const client of wss.clients) client.terminate();
          wss.close();
        } finally {
          if (listenPort !== undefined) {
            // `close()` stops accepting and then waits for every open
            // connection to END — IDLE keep-alive sockets included, which is
            // the HTTP twin of the WebSocket case above. A browser (or undici,
            // or any HTTP/1.1 client) parks its socket after the last
            // response, so nothing is in flight and close() still sits there
            // until somebody's keep-alive timer fires: measured at a flat ~3s
            // against Node's own fetch, and up to this server's own 5s
            // `keepAliveTimeout` against a browser. `aai dev` pays that on
            // Ctrl-C AND on every watch restart, which is the rebuild loop
            // feeling sluggish for no visible reason.
            //
            // Dropping only the IDLE connections is what makes this safe: one
            // mid-request or awaiting its response is untouched, so no reply
            // is ever truncated. Sweeping rather than calling once is the
            // difference between usually and always: a client resolves its
            // response as soon as the body arrives, which can be before this
            // server's socket has finished transitioning to idle, so a single
            // call routinely runs a moment too early and the connection then
            // waits out its full timer anyway.
            const sweep = setInterval(() => httpServer.closeIdleConnections(), IDLE_SWEEP_MS);
            // Never let the sweep itself hold the process open.
            sweep.unref?.();
            try {
              await new Promise<void>((resolve, reject) => {
                httpServer.close((err) => (err ? reject(err) : resolve()));
                httpServer.closeIdleConnections();
              });
            } finally {
              clearInterval(sweep);
            }
          }
          listenPort = undefined;
        }
      }
    },
  };
}
