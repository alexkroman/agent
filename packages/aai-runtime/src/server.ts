// Copyright 2025 the AAI authors. MIT license.
import type { AgentServer, RuntimeServerOptions } from "./server-types.ts";

/**
 * Self-hosted agent HTTP + WebSocket server.
 *
 * {@link createRuntimeServer} wraps a runtime from `createRuntime` with an
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
import { buildClientConfig } from "@alexkroman1/aai/protocol";
import { errorMessage, omitUndefined } from "@alexkroman1/aai/utils";
import escapeHtml from "escape-html";
import { WebSocketServer } from "ws";
import { isHostAllowed, startHostSession } from "./host-mode.ts";
import { consoleLogger } from "./runtime-config.ts";
import { agentGateToken } from "./server-env.ts";
import { routeMatches, SERVER_ROUTES, WORKFLOW_CALLBACK_ROUTES } from "./server-routes.ts";
import { serveStatic } from "./server-static.ts";
import { declineSocket } from "./session-decline.ts";
import { createSessionEventsApi, SESSION_EVENTS_TOKEN_ENV } from "./session-events-api.ts";
import { enabledCarriers, handleTelephonyUpgrade } from "./telephony/telephony-server.ts";
import { adoptRequestTrace } from "./tracing.ts";
import { createWorkflowApi, WORKFLOW_API_TOKEN_ENV } from "./workflow-api.ts";
import { answerHandlerFailure, sendJson } from "./workflow-api-http.ts";
import { serveFetch } from "./workflow-http-adapter.ts";
import { installWorkflowSupport } from "./workflow-install.ts";
import { createWebhookHandler, MAX_WEBHOOK_BODY_BYTES, webhookToken } from "./workflow-webhook.ts";
import { asSessionWebSocket } from "./ws-handler.ts";

export type {
  AgentServer,
  RuntimeServerOptions,
  SessionRuntime,
  SharedServerOptions,
} from "./server-types.ts";

/**
 * Default bind address. Loopback, not every interface: this server has no
 * request authentication of its own, so binding `0.0.0.0` by default put a
 * developer's agent — and the provider credentials backing it — in reach of
 * anyone on the same network (a shared office or cafe LAN). Exposing it is now
 * an explicit choice by the caller.
 */
export const DEFAULT_LISTEN_HOST = "127.0.0.1";

/**
 * What the webhook route answers, as an `Allow` header.
 *
 * Derived from the route table rather than written beside it, so the verb the
 * dispatch gates on and the verb the refusal advertises cannot drift.
 */
const WEBHOOK_ALLOWED_METHODS = WORKFLOW_CALLBACK_ROUTES.webhook.methods.join(", ");

// A socket this server will not serve is turned away with a REASON — see
// `session-decline.ts`, which owns the three refusal paths.
export { rejectingRuntime } from "./session-decline.ts";

/**
 * How often shutdown re-drops idle keep-alive connections — see `close()`.
 * Short enough to be invisible next to a process exit, long enough that the
 * timer costs nothing on a shutdown that finishes immediately.
 */
const IDLE_SWEEP_MS = 25;

/**
 * Slowloris bound: how long a client may take to send its COMPLETE request
 * headers before the socket is reaped. A deployed agent's `/session` URL and
 * every `/:slug/*` route it serves are public, so a client that opens a
 * connection and dribbles headers must not hold a slot open — Node's default is
 * 60s, and a real voice/HTTP client sends its headers in one segment, so 20s is
 * generous. The request BODY phase is deliberately left on Node's default
 * `requestTimeout` (300s): a workflow upload (`PUT /workflows/uploads/*`) is a
 * legitimately long-bodied request, and the slowloris vector is the headers
 * phase this bounds, not the body.
 */
const SERVER_HEADERS_TIMEOUT_MS = 20_000;

/**
 * How long an idle keep-alive socket is kept between requests. Set explicitly
 * rather than left to Node's 5s default so the reap is a stated policy on a
 * public surface, not an implementation detail.
 */
const SERVER_KEEPALIVE_TIMEOUT_MS = 10_000;

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
 * import { createRuntime, createRuntimeServer } from "@alexkroman1/aai-runtime";
 *
 * const myAgent = agent({ name: "Support", systemPrompt: "…" });
 * const runtime = createRuntime({
 *   agent: myAgent,
 *   env: { ASSEMBLYAI_API_KEY: process.env.ASSEMBLYAI_API_KEY ?? "" },
 * });
 * const server = createRuntimeServer({ runtime, name: myAgent.name });
 * await server.listen(3000);
 * ```
 *
 * @public
 */
export function createRuntimeServer(options: RuntimeServerOptions): AgentServer {
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
   * serves it identically — `aai dev`, a self-hosted `createRuntimeServer`, and every
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
    // `agentGateToken`, not a bare read: a set-but-EMPTY gate variable used to
    // authenticate every caller, including one presenting no header at all.
    ...omitUndefined({ token: agentGateToken(env, WORKFLOW_API_TOKEN_ENV, logger) }),
    logger,
  });

  /**
   * `/.well-known/workflow/v1/webhook/:token` — the one workflow URL handed to a
   * third party.
   *
   * Mounted HERE, beside the workflow API and on the same lazy getter, because
   * every front door goes through `createRuntimeServer` — `aai dev`, a self-hosted
   * `server.mjs`, a deployed guest — and this route must answer identically on
   * all three. It used to be mounted by `createWorkflowSurface` instead, which
   * is gated on the DevKit's `workflowCode`/`stepCode` pair; those strings no
   * longer exist, so the route was reachable nowhere and every callback a
   * deployed run handed out 404'd.
   */
  const workflowWebhook = createWebhookHandler(() => runtime.workflows, logger);

  /**
   * The session event stream's read surface (`/session-events/:id`).
   *
   * Mounted beside the workflow API and for the same reason: every front door —
   * `aai dev`, a self-hosted `createRuntimeServer`, a deployed guest — serves it
   * identically, so a feature developed locally cannot 404 once deployed. Same
   * lazy getter, for the same lazy-runtime reason.
   */
  const sessionEventsApi = createSessionEventsApi({
    stream: () => runtime.sessionEvents,
    // Same read as the workflow API's, and the more expensive one to get wrong:
    // this route is OFF when unset, so a blank value turned it ON unauthenticated.
    ...omitUndefined({ token: agentGateToken(env, SESSION_EVENTS_TOKEN_ENV, logger) }),
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
        page: isStatic ? "static" : "voice",
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
    if (routeMatches(SERVER_ROUTES.clientConfig, url, method)) {
      sendClientConfig(res);
      return;
    }

    if (clientDir && (await serveStatic(clientDir, req, res, logger))) return;

    if (routeMatches(SERVER_ROUTES.root, url, method)) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(defaultHtml);
      return;
    }

    logger.error(`${method} ${url} 404`);
    sendJson(res, 404, { error: "Not found" });
  }

  const httpServer = http.createServer((req, res) => {
    // Adopt an inbound `traceparent` before anything else runs, so a model call
    // this request causes lands in the CALLER's trace rather than rooting its
    // own. One undefined check when tracing is off, which is every front door
    // that has not configured a collector — see `tracing.ts`.
    adoptRequestTrace(req.headers);
    const url = requestPath(req.url);
    const method = req.method ?? "GET";

    res.setHeader("Content-Security-Policy", AGENT_CSP);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");

    if (routeMatches(SERVER_ROUTES.health, url, method)) {
      sendJson(res, 200, { status: "ok", name });
      return;
    }
    if (options.request?.(req, res, url, method)) return;
    // After the embedder's hook (which owns the DevKit's own queue callbacks and
    // the guest's manage surface) and before static serving, so a client asset
    // named `workflows` can never shadow the API.
    if (workflowApi(req, res, url, method)) return;
    const hookToken = webhookToken(url);
    if (hookToken !== undefined) {
      // The verb gate is a SECURITY control here, not a nicety. A delivery is
      // permanent — it resolves the run's waitpoint and closes the hook — so
      // while this route took any verb, a bare `GET` from a link-preview
      // fetcher, a URL scanner or a crawler resolved an approval workflow with
      // an empty payload and nobody's consent. A delivery carries a payload, so
      // it is a verb that has one; the rest are refused BEFORE the handler,
      // which is the only place that cannot be undone.
      if (!routeMatches(WORKFLOW_CALLBACK_ROUTES.webhook, url, method)) {
        // `Allow` named, so a sender that guessed wrong can correct itself
        // rather than reading the refusal as "this hook is gone" and stopping.
        res.writeHead(405, {
          "Content-Type": "application/json",
          Allow: WEBHOOK_ALLOWED_METHODS,
        });
        res.end(JSON.stringify({ error: `Webhook delivery must be ${WEBHOOK_ALLOWED_METHODS}` }));
        return;
      }
      void serveFetch((request) => workflowWebhook(hookToken, request), req, res, {
        logger,
        label: "Workflow webhook",
        // 502, not 500: the caller is a third party whose retry loop reads a 5xx
        // as "come back". An ordinary MISS never reaches here — the handler
        // answers that 404 itself, which is what stops the loop.
        failureStatus: 502,
        // The cap the route publishes, applied to the STREAM: without it the
        // body was fully buffered and only then measured, which on a door with
        // no credential is an attacker choosing this process's memory use.
        maxBodyBytes: MAX_WEBHOOK_BODY_BYTES,
      });
      return;
    }
    if (sessionEventsApi(req, res, url, method)) return;
    handleRequest(req, res, url, method).catch((err: unknown) => {
      // A rejection here would otherwise be an unhandled rejection that can
      // take down the process; answer 500 when possible, else drop the socket.
      answerHandlerFailure(res, logger, "Request handler failed", errorMessage(err));
    });
  });

  // Public-surface hardening (see the constants above): bound the headers phase
  // so a slowloris client is reaped, and state the idle keep-alive policy.
  httpServer.headersTimeout = SERVER_HEADERS_TIMEOUT_MS;
  httpServer.keepAliveTimeout = SERVER_KEEPALIVE_TIMEOUT_MS;

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
    // Resolved once per upgrade rather than hoisted, for the same reason `page`
    // is read off `options` here: this server is rebuilt on every `aai dev` file
    // save, so a captured value is a declaration one edit stale. Empty is the
    // default — `/phone` serves the carriers something DECLARED and no others.
    if (
      handleTelephonyUpgrade({
        req,
        socket,
        head,
        wss,
        runtime,
        logger,
        carriers: enabledCarriers(options.telephony),
      })
    ) {
      return;
    }
    if (isStatic && routeMatches(SERVER_ROUTES.session, url)) {
      // Completed and then declined WITH A REASON, rather than destroyed. A
      // bare socket drop leaves the client reconnecting against a server that
      // will never answer, with nothing in the frame log explaining why — and
      // "this agent serves a static page" is exactly the sentence whoever wired
      // `mountClient()` into a `page: "static"` app needs to read.
      logger.warn(`WS upgrade ${url} rejected: this agent serves a static page`);
      wss.handleUpgrade(req, socket, head, (ws) => {
        declineSocket(
          ws,
          "this agent serves a static page, not voice sessions — " +
            "mount it with mountPage() and talk to it over the workflow API",
          logger,
        );
      });
      return;
    }
    if (!routeMatches(SERVER_ROUTES.session, url)) {
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

  // Post-listen server errors have no promise to reject into (listen()'s
  // one-shot reject is removed once bound) — log instead of crashing on an
  // unhandled 'error' event.
  httpServer.on("error", (err) => {
    logger.error("HTTP server error", { error: errorMessage(err) });
  });

  return {
    // The wired-but-unbound `node:http` server, for a host that binds it
    // itself — see `AgentServer.node`, which carries the argument.
    node: httpServer,

    get port() {
      // ASKED of the server rather than latched by `listen()` below. A caller
      // that took `node` and bound it itself — every serverless host does —
      // never goes through our `listen`, and a recorded port would answer
      // `undefined` for a server that is plainly serving. A string address is
      // a pipe or a UNIX socket, which has no port.
      const addr = httpServer.address();
      return typeof addr === "object" && addr ? addr.port : undefined;
    },

    async listen(port = 3000, host = DEFAULT_LISTEN_HOST) {
      await new Promise<void>((resolve, reject) => {
        // `once` + removal on success: a persistent reject here would pile up
        // one listener per listen() call and reject a long-settled promise.
        httpServer.once("error", reject);
        httpServer.listen(port, host, () => {
          httpServer.removeListener("error", reject);
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
          // `listening`, not a port this handle recorded: a host that bound
          // `node` itself still gets its socket closed here, and a server that
          // never bound has nothing to close either way.
          if (httpServer.listening) {
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
        }
      }
    },
  };
}
