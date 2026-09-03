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
import type { AgentDef } from "@alexkroman1/aai";
import type { Logger } from "./runtime-config.ts";
import type { AgentRuntime } from "./runtime-types.ts";

/**
 * The session-facing slice of a runtime — all {@link createServer} needs.
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

/** Configuration for {@link createServer}. */
/**
 * The options every front door over {@link createServer} passes straight
 * through — a logger and the two request hooks.
 *
 * Shared rather than restated because {@link createAgentServer} and
 * `createHostServer` are wrappers, not alternative APIs: a hook added here has
 * to reach both, and three identically-documented fields copied into each is
 * how one of them silently stops offering it.
 *
 * Spreading a bag of these into {@link ServerOptions} is the point, and for a
 * while it did not compile. An optional field spreads as `T | undefined`, so
 * the three matching fields on `ServerOptions` have to ACCEPT `undefined` or
 * `exactOptionalPropertyTypes` rejects the whole object (TS2379) — which meant
 * the one bag that exists to reach all three front doors could not be handed to
 * any of them, and each wrapper forwarded the fields one at a time instead.
 * They carry `| undefined` now, on both sides; do not narrow either back.
 */
export type PassthroughServerOptions = {
  /** Structured logger. Defaults to the console logger. */
  logger?: Logger | undefined;
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
   * them: `/websocket` is declined with a reason, and telephony defaults OFF (an
   * agent with no `stt`/`llm`/`tts` has nothing to put on a call). It is
   * reported in `GET /client-config` so a browser knows before it dials.
   */
  page?: "voice" | "static";
  /**
   * Serve carrier media streams on `WS /phone` (Twilio, Telnyx — see
   * `telephony/carriers.ts`). Defaults to true for a voice agent, and to FALSE
   * for a `page: "static"` one.
   *
   * On by default because it grants exactly what `/websocket` beside it
   * already grants — the same session, agent and credentials — so it is not
   * the kind of surface the loopback bind and the host-mode flag are
   * fail-closed about. Set false to remove the route.
   */
  telephony?: boolean;
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
