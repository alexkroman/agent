// Copyright 2025 the AAI authors. MIT license.
/**
 * Node guest-side harness entrypoint — runs the COMPLETE agent.
 *
 * The harness embeds the SDK runtime (`createRuntime`) and serves two
 * WebSocket surfaces on its tunneled port:
 *
 * - `/ws` — the host control channel, authenticated by the per-sandbox
 *   bearer token (AAI_GUEST_TOKEN, delivered via the exec env; the tunnel
 *   URL is public, so an upgrade without the token is rejected). JSON-RPC
 *   both ways: host→guest `bundle/load`, `tool/execute` (one-shot trials —
 *   the studio's test_agent), `status`, and the `shutdown` notification;
 *   guest→host `db/query` (ctx.db — platform Postgres credentials never
 *   enter tenant containers).
 * - `/websocket` — PUBLIC client voice sessions, connected DIRECTLY by
 *   browsers (the same path `aai dev` serves). Each upgrade starts a
 *   runtime session: STT/LLM/TTS provider streams, the LLM loop, tool
 *   execution, and audio pacing all run here, in the tenant's own
 *   container, on the tenant's own credentials.
 *
 * Clients discover the current session URL from the platform's
 * `GET /:slug/client-config` broker — the URL changes when the sandbox is
 * replaced, and the broker names the live one.
 *
 * The session surface IS the dev server: the harness wraps the same
 * `createServer` `aai dev` runs (health, client-config, `/websocket`
 * sessions), adding only the `/ws` control channel via the server's
 * `upgrade` hook and a lazy runtime facade (the runtime is built on the
 * first session, never at bundle/load — inspection loads carry an empty
 * env that must not fail on missing provider credentials).
 *
 * Network egress is open — the Modal container is the isolation boundary;
 * tool code and providers dial out directly, exactly as under `aai dev`.
 *
 * The harness (with the SDK runtime and provider SDKs) is bundled into one
 * self-contained artifact and baked into the guest snapshot image.
 *
 * Run with: node harness.mjs
 */

import { timingSafeEqual } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  type AgentRuntime,
  createRuntime,
  createServer,
  type SessionRuntime,
} from "@alexkroman1/aai/runtime";
import { type WebSocket, WebSocketServer } from "ws";
import {
  dbAdapter,
  errMsg,
  handleHostResponse,
  rejectAllPendingHostRequests,
  sendError,
  sendResponse,
  setHostSend,
} from "./harness-rpc.ts";
import type {
  AgentDef,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
} from "./harness-types.ts";
import { HARNESS_ORPHAN_POLL_MS, HARNESS_ORPHAN_TIMEOUT_MS } from "./limits.ts";
import {
  handleStudioRequest,
  initStudioSession,
  type StudioSession,
  type StudioSessionParams,
} from "./studio-chat.ts";
import { executeTool, runCode, type ToolCallRequest } from "./trial.ts";

// ---- bundle/load ------------------------------------------------------------

let bundleSeq = 0;

/**
 * Import raw JS source as an ES module (no Function() evaluation, top-level
 * await supported). The code lands in a uniquely named temp file and is
 * imported by file URL — the unique name matters because Node's module
 * registry caches by URL, and a repeat bundle/load (the studio's build →
 * load → try loop) must load the NEW code.
 */
async function importBundleModule(code: string): Promise<Record<string, unknown>> {
  const path = `/tmp/aai-bundle-${process.pid}-${++bundleSeq}.mjs`;
  await writeFile(path, code, "utf-8");
  return await import(pathToFileURL(path).href);
}

// ---- Harness state ----------------------------------------------------------

/** Mutable state shared across requests within a single harness instance. */
export type HarnessState = {
  agent: AgentDef | null;
  env: Readonly<Record<string, string>>;
  storageEnabled: boolean;
  /**
   * The live runtime, created lazily on the first `/websocket` session upgrade —
   * NEVER at bundle/load: runtime construction resolves provider
   * credentials, and inspection loads (describeBundle, the studio) carry an
   * empty env that must not fail the load.
   */
  runtime: AgentRuntime | null;
  /** Live client-session connections (host idle eviction asks). */
  activeSessions: number;
  /**
   * The studio coding-agent session, installed by `studio/session-init` —
   * workspace dir, the caller's key (chat bearer + LLM credential), and
   * turn config. Null on non-studio sandboxes; `/studio/chat` answers 409.
   */
  studio: StudioSession | null;
};

/**
 * Load an agent ESM bundle delivered as raw JS source code.
 *
 * Bundles built by the browser studio also export `__aaiConfig` — the agent
 * config extracted *inside* the bundle (by `@alexkroman1/aai/manifest`
 * helpers bundled in). Returning it lets the host obtain the config without
 * ever evaluating user code outside the sandbox.
 */
async function loadBundle(
  state: HarnessState,
  params: { code: string; env: Record<string, string>; storageEnabled: boolean },
): Promise<{ config?: unknown }> {
  // A repeat load replaces the loaded agent; any live runtime ran the OLD
  // code — tear it down so the next session runs the new bundle.
  const oldRuntime = state.runtime;
  state.runtime = null;
  if (oldRuntime) void oldRuntime.shutdown().catch(() => undefined);

  const mod = await importBundleModule(params.code);
  const agent = (mod.default ?? mod) as AgentDef;

  if (!agent || typeof agent !== "object") {
    throw new Error("Agent bundle must export an object");
  }

  state.agent = agent;
  state.env = Object.freeze({ ...params.env });
  state.storageEnabled = params.storageEnabled;

  const config = (mod as { __aaiConfig?: unknown }).__aaiConfig;
  return config === undefined ? {} : { config };
}

/**
 * The runtime for the loaded bundle, created on first use. This is the
 * SDK's self-hosted path running INSIDE the sandbox: tools execute
 * in-process, providers and tool-code fetch dial out directly (open
 * egress — the container is the boundary), exactly as `aai dev` does.
 * ctx.db proxies to the host over the control channel; run_code gets this
 * guest's real executor.
 */
export function ensureRuntime(state: HarnessState): AgentRuntime {
  if (!state.agent) throw new Error("Agent not loaded");
  state.runtime ??= createRuntime({
    // The bundle's default export is the full agent definition (providers,
    // tools, hooks); the harness's own AgentDef type is just its loose view.
    agent: state.agent as never,
    env: { ...state.env },
    ...(state.storageEnabled ? { db: dbAdapter } : {}),
    runCode,
  });
  return state.runtime;
}

// ---- Control-channel dispatch -----------------------------------------------

/** Resolve and settle a single incoming JSON-RPC request. */
export async function handleRequest(req: JsonRpcRequest, state: HarnessState): Promise<void> {
  switch (req.method) {
    case "bundle/load": {
      if (!req.params || typeof (req.params as Record<string, unknown>).code !== "string") {
        sendError(req.id, -32_602, "bundle/load requires { code: string, env: {} }");
        break;
      }
      const params = req.params as {
        code: string;
        env?: Record<string, string>;
        storageEnabled?: boolean;
      };
      const loaded = await loadBundle(state, {
        code: params.code,
        env: params.env ?? {},
        storageEnabled: params.storageEnabled === true,
      });
      sendResponse(req.id, { ok: true, ...loaded });
      break;
    }

    case "tool/execute": {
      if (!state.agent) {
        sendError(req.id, -32_000, "Agent not loaded");
        break;
      }
      const toolResult = await executeTool(state.agent, req.params as ToolCallRequest, {
        storageEnabled: state.storageEnabled,
        env: state.env,
      });
      sendResponse(req.id, toolResult);
      break;
    }

    case "status": {
      sendResponse(req.id, { activeSessions: state.activeSessions });
      break;
    }

    case "studio/session-init": {
      const params = req.params as StudioSessionParams | undefined;
      if (!params || typeof params.apiKey !== "string" || typeof params.files !== "object") {
        sendError(req.id, -32_602, "studio/session-init requires { files, apiKey, ... }");
        break;
      }
      state.studio = await initStudioSession(params);
      sendResponse(req.id, { ok: true });
      break;
    }

    default:
      sendError(req.id, -32_601, `Method not found: ${req.method}`);
  }
}

export function handleNotification(notif: JsonRpcNotification): void {
  // The frame came off the wire — a malformed notification with no string
  // `method` must be ignored, not allowed to throw and kill the handler.
  if (typeof notif?.method !== "string") return;
  if (notif.method === "shutdown") process.exit(0);
}

export function dispatchMessage(msg: JsonRpcMessage, state: HarnessState): void {
  // Incoming response to a host RPC request we sent (db/query)
  if ("id" in msg && !("method" in msg)) {
    handleHostResponse(msg as JsonRpcResponse);
    return;
  }
  // Notification (no id)
  if (!("id" in msg)) {
    handleNotification(msg as JsonRpcNotification);
    return;
  }
  // Request — handle concurrently so the socket keeps draining.
  const req = msg as JsonRpcRequest;
  void handleRequest(req, state).catch((err) => {
    sendError(req.id, -32_603, errMsg(err));
  });
}

// ---- Servers -------------------------------------------------------------

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function bearerToken(header: string | undefined): string | null {
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length);
}

/**
 * The session-facing runtime handed to `createServer` — a lazy facade over
 * `ensureRuntime` so the real runtime is built on the FIRST session (with
 * the loaded bundle's env), plus the live-session count the host's idle
 * eviction asks for over `status`.
 */
export function lazyRuntime(state: HarnessState): SessionRuntime {
  return {
    startSession(ws, opts) {
      state.activeSessions++;
      const socket = ws as unknown as WebSocket;
      socket.on("close", () => {
        state.activeSessions = Math.max(0, state.activeSessions - 1);
      });
      let runtime: AgentRuntime;
      try {
        runtime = ensureRuntime(state);
      } catch (err) {
        // No bundle yet, or the runtime can't be built (missing provider
        // credential, invalid config) — answer with a close frame naming
        // the cause instead of a dangling socket.
        console.error(`session refused: ${errMsg(err)}`);
        socket.close(1011, errMsg(err).slice(0, 100));
        return;
      }
      runtime.startSession(ws, opts);
    },
    shutdown: async () => {
      await state.runtime?.shutdown();
    },
  };
}

function main(): void {
  const token = process.env.AAI_GUEST_TOKEN;
  if (!token) {
    console.error("AAI_GUEST_TOKEN is required");
    process.exit(1);
  }
  const port = Number(process.env.AAI_GUEST_PORT ?? "8080");
  // Every backend (Modal, Apple containers) gives the guest its own network
  // namespace, so binding every interface reaches no further than the
  // container — and a container that cannot be reached on its published port
  // is the more damaging failure.
  const host = "0.0.0.0";

  const state: HarnessState = {
    agent: null,
    env: Object.freeze({}),
    storageEnabled: false,
    runtime: null,
    activeSessions: 0,
    studio: null,
  };
  let hostSocket: WebSocket | null = null;
  let lastConnectedAt = Date.now();

  // The control channel keeps ws's default payload cap — bundle/load frames
  // run to ~10 MB; client sessions get the protocol's own cap (applied by
  // createServer's WebSocketServer).
  const controlWss = new WebSocketServer({ noServer: true });

  controlWss.on("connection", (ws) => {
    hostSocket = ws;
    lastConnectedAt = Date.now();
    setHostSend((msg) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    });

    ws.on("message", (data) => {
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(String(data)) as JsonRpcMessage;
      } catch {
        return; // malformed frame — skip
      }
      dispatchMessage(msg, state);
    });

    ws.on("close", () => {
      // The control connection is host liveness. Nothing pending can be
      // answered, and the host never redials — the orphan check below exits
      // this process once the timeout elapses (the sandbox terminate usually
      // lands first).
      if (hostSocket === ws) {
        hostSocket = null;
        lastConnectedAt = Date.now();
        setHostSend(null);
      }
      rejectAllPendingHostRequests("Connection closed");
    });
    ws.on("error", () => {
      // close follows; nothing to do here beyond not crashing.
    });
  });

  // The studio chat surface's view of this harness's own loader + trial
  // executor — test_agent loads and trials bundles in-place.
  const studioDeps = {
    loadBundle: (code: string) => loadBundle(state, { code, env: {}, storageEnabled: false }),
    executeTool: async (name: string, args: Record<string, unknown>) => {
      if (!state.agent) return "Tool error: agent not loaded";
      const response = await executeTool(
        state.agent,
        { name, args, sessionId: "studio-trial", state: null },
        { storageEnabled: false, env: state.env },
      );
      if (response.error) return `Tool error: ${response.error}`;
      return response.result ?? "(no result)";
    },
  };

  // The dev server's HTTP+WS surface (health, client-config, /websocket
  // sessions), with the control channel claimed first via the upgrade hook
  // and the studio chat surface claimed via the request hook.
  const server = createServer({
    runtime: lazyRuntime(state),
    request: (req, res, url, method) =>
      handleStudioRequest(state.studio, studioDeps, req, res, url, method),
    upgrade: (req, socket, head) => {
      const pathname = (req.url ?? "/").split("?")[0];
      if (pathname !== "/ws") return false;

      // The control channel: the tunnel URL is public — an upgrade without
      // the per-sandbox bearer token is rejected before the handshake.
      const supplied = bearerToken(req.headers.authorization);
      if (!(supplied && constantTimeEquals(supplied, token))) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return true;
      }
      // One host per harness: a second authenticated dial would interleave
      // two hosts' RPC streams. The host never redials a live sandbox.
      if (hostSocket) {
        socket.write("HTTP/1.1 409 Conflict\r\n\r\n");
        socket.destroy();
        return true;
      }
      controlWss.handleUpgrade(req, socket, head, (ws) => {
        controlWss.emit("connection", ws, req);
      });
      return true;
    },
  });

  // Orphan check: with no host control connection past the window — host
  // died without teardown, or never dialed — exit so Modal's idle timeout
  // can reclaim the sandbox instead of billing it to the lifetime cap.
  const orphanCheck = setInterval(() => {
    if (hostSocket === null && Date.now() - lastConnectedAt > HARNESS_ORPHAN_TIMEOUT_MS) {
      console.error(
        `Harness orphaned: no host connection for ${HARNESS_ORPHAN_TIMEOUT_MS}ms; exiting`,
      );
      process.exit(3);
    }
  }, HARNESS_ORPHAN_POLL_MS);
  orphanCheck.unref?.();

  void server.listen(port, host).then(() => {
    console.error(`harness listening on ${host}:${port}`);
  });
}

// Only start the server when executed directly (not when imported in tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
