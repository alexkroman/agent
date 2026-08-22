// Copyright 2025 the AAI authors. MIT license.
import type { AgentServer, ServerOptions } from "./server-types.ts";

/**
 * Self-hosted agent HTTP + WebSocket server.
 *
 * {@link createServer} wraps a runtime from `createRuntime` with an
 * HTTP + WebSocket server using only `node:http` and `ws` (no framework
 * dependencies) — the same server `aai dev` runs. Use it to host an agent on
 * your own infrastructure instead of the managed platform: see
 * `examples/self-hosted-server` for a runnable setup.
 *
 * Import via `@alexkroman1/aai-runtime`.
 */

import http from "node:http";
import {
  AGENT_CSP,
  MAX_WS_PAYLOAD_BYTES,
  parseWsUpgradeParams,
  requestPath,
  requestQuery,
} from "@alexkroman1/aai/host-internal";
import {
  buildClientConfig,
  CLIENT_CONFIG_METHODS,
  CLIENT_CONFIG_PATH,
} from "@alexkroman1/aai/protocol";
import { errorMessage, omitUndefined } from "@alexkroman1/aai/utils";
import escapeHtml from "escape-html";
import { WebSocketServer } from "ws";
import { isHostAllowed, startHostSession } from "./host-mode.ts";
import { consoleLogger } from "./runtime-config.ts";
import { serveStatic } from "./server-static.ts";
import { declineSocket } from "./session-decline.ts";
import { createSessionEventsApi, SESSION_EVENTS_TOKEN_ENV } from "./session-events-api.ts";
import { handleTelephonyUpgrade } from "./telephony/telephony-server.ts";
import { createWorkflowApi, WORKFLOW_API_TOKEN_ENV } from "./workflow-api.ts";
import { answerHandlerFailure, sendJson } from "./workflow-api-http.ts";
import { installWorkflowSupport } from "./workflow-install.ts";
import { asSessionWebSocket } from "./ws-handler.ts";

export type {
  AgentServer,
  PassthroughServerOptions,
  ServerOptions,
  SessionRuntime,
} from "./server-types.ts";

export const DEFAULT_LISTEN_HOST = "127.0.0.1";

// A socket this server will not serve is turned away with a REASON — see
// `session-decline.ts`, which owns the three refusal paths.
export { decliningRuntime } from "./session-decline.ts";

/**
 * How often shutdown re-drops idle keep-alive connections — see `close()`.
 * Short enough to be invisible next to a process exit, long enough that the
 * timer costs nothing on a shutdown that finishes immediately.
 */
const IDLE_SWEEP_MS = 25;

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
 * import { createRuntime, createServer } from "@alexkroman1/aai-runtime";
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

  /**
   * The upload store and the three step slots a `"use step"` function reads.
   *
   * The HANDLE is held, not just its store: what this call opens (an upload
   * pool, a keep-alive pool) is this server's to close, and `aai dev` builds a
   * new server on every save. See `installWorkflowSupport`.
   */
  const workflowSupport = installWorkflowSupport({
    ...omitUndefined({ env, uploadBroker: options.uploadBroker }),
    logger,
  });

  /**
   * The durable-workflow API (`/workflows/*`).
   *
   * Mounted here rather than left to the `request` hook so every front door
   * serves it identically — `aai dev`, a self-hosted `createServer`, and every
   * deployed guest — for the same reason `/phone` is mounted here. The client is
   * read through a GETTER because the guest harness builds its runtime lazily,
   * on the first thing that needs it: for a static app that first thing is a
   * request to this API, so capturing the value now would capture `undefined`
   * for the lifetime of the server.
   */
  const workflowApi = createWorkflowApi({
    engine: () => runtime.workflows,
    uploads: workflowSupport.uploads,
    // Reported by the call that BUILT the store rather than re-derived here, so the
    // claim and the store cannot disagree — which they did, for every databaseless
    // agent. See `uploadBytesAreRemote`.
    directParts: workflowSupport.directParts,
    ...omitUndefined({ token: env?.[WORKFLOW_API_TOKEN_ENV] }),
    logger,
  });

  /**
   * The session event stream's read surface (`/session-events/:id`).
   *
   * Mounted beside the workflow API and for the same reason: every front door —
   * `aai dev`, a self-hosted `createServer`, a deployed guest — serves it
   * identically, so a feature developed locally cannot 404 once deployed. Same
   * lazy getter, for the same lazy-runtime reason.
   */
  const sessionEventsApi = createSessionEventsApi({
    stream: () => runtime.sessionEvents,
    ...omitUndefined({ token: env?.[SESSION_EVENTS_TOKEN_ENV] }),
    logger,
  });

  // Pre-connection client config: how the default client should talk to
  // this agent (see sdk/client-config.ts).
  function sendClientConfig(res: http.ServerResponse): void {
    sendJson(
      res,
      200,
      buildClientConfig({
        name,
        greeting: options.greeting,
        // Only when static: absent already reads as "voice" everywhere, and a
        // server that has never heard of the field answers the same way.
        ...(isStatic ? { page: "static" as const } : {}),
      }),
    );
  }

  async function handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: string,
    method: string,
  ): Promise<void> {
    // Registered before static serving so a client asset can never shadow
    // the client-config endpoint.
    if (CLIENT_CONFIG_METHODS.includes(method) && url === `/${CLIENT_CONFIG_PATH}`) {
      sendClientConfig(res);
      return;
    }

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
    const url = requestPath(req.url);
    const method = req.method ?? "GET";

    res.setHeader("Content-Security-Policy", AGENT_CSP);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");

    if (method === "GET" && url === "/health") {
      sendJson(res, 200, { status: "ok", name });
      return;
    }
    if (options.request?.(req, res, url, method)) return;
    // After the embedder's hook (which owns the DevKit's own queue callbacks and
    // the guest's manage surface) and before static serving, so a client asset
    // named `workflows` can never shadow the API.
    if (workflowApi(req, res, url, method)) return;
    if (sessionEventsApi(req, res, url, method)) return;
    handleRequest(req, res, url, method).catch((err: unknown) => {
      // A rejection here would otherwise be an unhandled rejection that can
      // take down the process; answer 500 when possible, else drop the socket.
      answerHandlerFailure(res, logger, "Request handler failed", errorMessage(err));
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

    const url = requestPath(req.url);
    // A static agent declares no STT/LLM/TTS, so a carrier stream has nothing to
    // talk to — the default follows the declaration rather than making every
    // workflow app remember to switch it off. An explicit `telephony: true`
    // still wins, since the field is the more specific statement.
    const telephony = options.telephony ?? !isStatic;
    if (handleTelephonyUpgrade({ req, socket, head, wss, runtime, logger, enabled: telephony })) {
      return;
    }
    if (isStatic && url.startsWith("/websocket")) {
      // Completed and then declined WITH A REASON, rather than destroyed. A
      // bare socket drop leaves the client reconnecting against a server that
      // will never answer, with nothing in the frame log explaining why — and
      // "this agent serves a static page" is exactly the sentence whoever wired
      // `client()` into a `page: "static"` app needs to read.
      logger.warn(`WS upgrade ${url} rejected: this agent serves a static page`);
      wss.handleUpgrade(req, socket, head, (ws) => {
        declineSocket(
          ws,
          "this agent serves a static page, not voice sessions — " +
            "mount it with page() and talk to it over the workflow API",
          logger,
        );
      });
      return;
    }
    if (!url.startsWith("/websocket")) {
      // No other upgrade consumer exists on this server: an unmatched upgrade
      // socket would otherwise dangle forever with no error handling.
      socket.destroy();
      return;
    }

    const wantsHost = requestQuery(req.url).has("host");

    wss.handleUpgrade(req, socket, head, (ws) => {
      const startOpts = parseWsUpgradeParams(req.url ?? "");
      const session = asSessionWebSocket(ws);

      // Host mode: defer startSession until the first `config` frame supplies
      // the per-connection agent. Requires `env` (for gating + secrets).
      if (wantsHost && env && isHostAllowed(env)) {
        logger.info(`WS upgrade ${url} (host mode)`);
        startHostSession(session, {
          env,
          startOpts,
          logger,
          ...omitUndefined({ baseAgent: hostBaseAgent }),
        });
        return;
      }
      if (wantsHost) {
        logger.warn(`WS upgrade ${url} rejected: host mode unavailable`);
        declineSocket(ws, "host mode is not enabled on this server", logger);
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
        // The pools this server OPENED. `aai dev` rebuilds a server on every
        // save, and a pool nothing releases is stranded for the life of the
        // process. Never rejects.
        await workflowSupport.close();
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
