// Copyright 2026 the AAI authors. MIT license.
/**
 * The agent server's public shape, split from its implementation.
 *
 * `server.ts` sat at the 500-line cap and these four exported types are ~135
 * of those lines with no behaviour in them — the same seam
 * `session-core-types.ts` takes, for the same reason. `server.ts` re-exports
 * all four, so every existing import path is unchanged.
 */

import type http from "node:http";
import type { AgentDef, TelephonyAccess } from "@alexkroman1/aai";
import type { Logger } from "./runtime-config.ts";
import type { AgentRuntime } from "./runtime-types.ts";

/**
 * The session-facing slice of a runtime — all {@link createRuntimeServer} needs.
 * A runtime built with `createRuntime` satisfies it directly.
 *
 * Narrowed to these members (rather than demanding a full `AgentRuntime`) so an
 * embedder can supply a lazily-built runtime facade. `workflows` is optional on
 * `AgentRuntime` itself, so a facade written before it existed still satisfies
 * this — the workflow API then answers 404, which is the truthful reply for a
 * runtime that offers no client.
 */
export type SessionRuntime = Pick<
  AgentRuntime,
  "startSession" | "shutdown" | "workflows" | "sessionEvents" | "deliverWorkflow"
>;

/** Configuration for {@link createRuntimeServer}. */
/**
 * The options every front door over {@link createRuntimeServer} passes straight
 * through — a logger and the two request hooks.
 *
 * Shared rather than restated because {@link createAgentServer} and
 * `createHostServer` are wrappers, not alternative APIs: a hook added here has
 * to reach both, and three identically-documented fields copied into each is
 * how one of them silently stops offering it.
 *
 * Spreading a bag of these into {@link RuntimeServerOptions} is the point, and for a
 * while it did not compile. An optional field spreads as `T | undefined`, so
 * the three matching fields on `RuntimeServerOptions` have to ACCEPT `undefined` or
 * `exactOptionalPropertyTypes` rejects the whole object (TS2379) — which meant
 * the one bag that exists to reach all three front doors could not be handed to
 * any of them, and each wrapper forwarded the fields one at a time instead.
 * They carry `| undefined` now, on both sides; do not narrow either back.
 */
export type SharedServerOptions = {
  /** Structured logger. Defaults to the console logger. */
  logger?: Logger | undefined;
  /** First look at every WebSocket upgrade — see {@link RuntimeServerOptions.upgrade}. */
  upgrade?: RuntimeServerOptions["upgrade"];
  /** First look at every HTTP request — see {@link RuntimeServerOptions.request}. */
  request?: RuntimeServerOptions["request"];
};

export type RuntimeServerOptions = {
  /** The runtime sessions are started on — see `createRuntime`. */
  runtime: SessionRuntime;
  /** Display name served by `GET /client-config`. Defaults to `"agent"`. */
  name?: string;
  /** Directory of static client assets to serve at `/`. */
  clientDir?: string;
  /** Structured logger. Defaults to the console logger. */
  logger?: Logger | undefined;
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
   * Base URL of a PLATFORM that serves this agent's upload bytes for it.
   *
   * Its presence puts workflow uploads on the brokered path, where every byte operation
   * goes to `<uploadBroker>/uploads/<id>/<offset>` and this process holds no bucket
   * credential; absent, the store reads the `AAI_UPLOAD_STORAGE_*` keys and talks to a
   * bucket itself, as `aai dev` does. `host/_upload-blobs.ts` has the argument.
   *
   * **Deliberately NOT `publicUrl`.** That one answers "where do third parties reach
   * me", which a self-hosted agent behind a proxy also answers — reusing it would put
   * such an agent on a byte route nothing serves. This is a claim about the DEPLOYMENT.
   */
  uploadBroker?: string;
  /**
   * First look at every WebSocket upgrade. Return true to claim it (the
   * server then leaves the socket alone); return false to fall through to
   * the standard `/websocket` session handling. Lets an embedder (the
   * platform's guest harness) add its own upgrade surface — its host
   * control channel — without a second HTTP server.
   */
  upgrade?:
    | ((req: http.IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) => boolean)
    | undefined;
  /**
   * First look at every HTTP request (after `/health`). Return true to claim
   * it — the server then leaves the response alone. The `upgrade` hook's
   * HTTP twin: lets an embedder (the platform's guest harness) add its own
   * HTTP surface — the studio coding agent's chat endpoint — without a
   * second HTTP server.
   */
  request?:
    | ((
        req: http.IncomingMessage,
        res: http.ServerResponse,
        url: string,
        method: string,
      ) => boolean)
    | undefined;
  /**
   * What this server's front door IS — see `AgentDef.page`. Defaults to
   * `"voice"`.
   *
   * `"static"` turns off the voice surfaces rather than merely not advertising
   * them: `/websocket` is declined with a reason. It is reported in
   * `GET /client-config` so a browser knows before it dials. (Telephony is off
   * for a static agent because it is off for EVERY agent that does not declare
   * a carrier — see `telephony` below.)
   */
  page?: "voice" | "static";
  /**
   * Which phone carriers may open a media stream on `WS /phone` — see
   * `AgentDef.telephony`. Defaults to NONE: the route refuses every upgrade
   * unless something declares a carrier.
   *
   * `createAgentServer` reads the declaration off the agent, which is where it
   * belongs; this is the same statement for an embedder that hands in a runtime
   * rather than an agent, and it is what that door forwards.
   *
   * It used to default ON for any voice agent, on the argument that the route
   * grants exactly what `/websocket` beside it grants — the same session, agent
   * and credentials. True, and beside the point: this is the one door dialled
   * from OUTSIDE the deployment, by a carrier following a phone number, and an
   * agent with no phone number was serving it without ever saying so.
   */
  telephony?: TelephonyAccess;
};

/** Handle returned by {@link createRuntimeServer}. */
export type AgentServer = {
  /**
   * Start listening. `host` defaults to {@link DEFAULT_LISTEN_HOST} (loopback)
   * — pass `"0.0.0.0"` to deliberately expose the server on other interfaces.
   */
  listen(port?: number, host?: string): Promise<void>;
  close(): Promise<void>;
  /**
   * The bound port, or `undefined` when this server is not listening.
   *
   * Read off the underlying {@link AgentServer.node} rather than recorded by
   * {@link AgentServer.listen}, so it is right no matter who bound the socket
   * — a host that took {@link AgentServer.node} and called `listen` on it
   * itself gets the port here, where a value latched by our own `listen` would
   * answer `undefined` for a server that is plainly serving.
   */
  port: number | undefined;
  /**
   * The `node:http` server underneath — fully wired (routes, the WebSocket
   * upgrade handler, the timeouts) and deliberately NOT listening.
   *
   * It is here because a serverless host is handed a server rather than
   * asked to start one: Vercel's Node runtime wants
   * `export default <http.Server>` from the module and binds the socket
   * itself, and Fastify/Express-shaped embedders likewise mount onto a server
   * object. Without this the only route was to `listen()` on an ephemeral port
   * inside the function and proxy HTTP plus upgrades to it — a hop that buys
   * nothing.
   *
   * ```ts
   * // deployed to Vercel through its own `@vercel/node` builder
   * import { agent } from "@alexkroman1/aai";
   * import { createAgentServer } from "@alexkroman1/aai-runtime";
   *
   * const server = createAgentServer({
   *   agent: agent({ name: "Support", systemPrompt: "You are helpful." }),
   *   env: { ASSEMBLYAI_API_KEY: process.env.ASSEMBLYAI_API_KEY ?? "" },
   * });
   *
   * export default server.node; // no listen() — the platform binds it
   * ```
   *
   * **`close()` still works** — it closes whatever is listening, so it does not
   * care which side called `listen`.
   *
   * ## A host that never raises `upgrade` can still serve a WebSocket
   *
   * This used to say Vercel Functions were request/response only and that
   * `WS /websocket` and `WS /phone` were therefore unreachable there. That is
   * wrong, and it is the claim a voice agent's whole deployment turns on. What
   * is true is narrower: some hosts do not raise the EVENT. Vercel exposes the
   * raw `{ req, socket, head }` through a per-request context instead
   * (`globalThis[Symbol.for("@vercel/request-context")].get().upgradeWebSocket()`),
   * and re-emitting that triple onto this server is the whole adapter — see
   * `VERCEL_ENTRY_SOURCE` in `@alexkroman1/aai-cli`, which `aai build --target
   * vercel` emits, and which is verified against a real handshake.
   *
   * So the rule is: reach for the host's own upgrade channel before concluding
   * it has none. A host that genuinely has neither still runs the HTTP surface
   * — `/health`, `/client-config`, `/workflows/*`, the webhook route, static
   * assets — which is what a `page: "static"` workflow app needs and all it
   * needs.
   */
  node: http.Server;
};

/**
 * Default bind address. Loopback, not every interface: this server has no
 * request authentication of its own, so binding `0.0.0.0` by default put a
 * developer's agent — and the provider credentials backing it — in reach of
 * anyone on the same network (a shared office or cafe LAN). Exposing it is now
 * an explicit choice by the caller.
 */
