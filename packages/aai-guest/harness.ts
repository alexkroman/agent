// Copyright 2025 the AAI authors. MIT license.
/**
 * Node guest-side harness entrypoint — runs the COMPLETE agent.
 *
 * The harness embeds NO agent runtime: the worker bundle ships its own
 * (`__aaiCreateRuntime`, the user's installed SDK bundled in by the CLI
 * wrapper), so a deployed agent runs exactly the runtime version it was
 * built against and platform SDK drift cannot break it. The harness serves
 * two WebSocket surfaces on its tunneled port:
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
 * The harness (server shell + studio coding agent) is bundled into one
 * self-contained artifact and baked into the guest snapshot image.
 *
 * Run with: node harness.mjs
 */

import { pathToFileURL } from "node:url";
import { createServer, type SessionRuntime } from "@alexkroman1/aai/runtime";
import { type WebSocket, WebSocketServer } from "ws";
import { verifyBearer } from "./harness-auth.ts";
import { ensureRuntime, type HarnessState, loadBundle } from "./harness-bundle.ts";
import { installCrashGuards } from "./harness-crash-guards.ts";
import {
  errMsg,
  handleHostResponse,
  rejectAllPendingHostRequests,
  sendError,
  sendResponse,
  setHostSend,
} from "./harness-rpc.ts";
import type {
  GuestRuntime,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
} from "./harness-types.ts";
import { HARNESS_ORPHAN_POLL_MS, HARNESS_ORPHAN_TIMEOUT_MS } from "./limits.ts";
import { BUILD_CHILD_FLAG, withBuildDir } from "./studio-build.ts";
import { handleStudioRequest, initStudioSession, type StudioSessionParams } from "./studio-chat.ts";
import { deployWorkspaceDir } from "./studio-publish.ts";
import { materializeWorkspace } from "./studio-workspace-fs.ts";
import { executeTool, type ToolCallRequest } from "./trial.ts";

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

    // Publish: run `aai deploy` IN THIS SANDBOX against a materialized
    // snapshot of the workspace (see studio-publish.ts) — the literal CLI,
    // so studio publishes and laptop deploys are one path, and the CLI's
    // output rides back for the chat.
    case "workspace/deploy": {
      const params = req.params as
        | { files?: unknown; serverUrl?: unknown; apiKey?: unknown; slug?: unknown }
        | undefined;
      if (
        !params ||
        typeof params.files !== "object" ||
        params.files === null ||
        typeof params.serverUrl !== "string" ||
        typeof params.apiKey !== "string"
      ) {
        sendError(req.id, -32_602, "workspace/deploy requires { files, serverUrl, apiKey }");
        break;
      }
      const files = params.files as Record<string, string>;
      const result = await withBuildDir(files, materializeWorkspace, (dir) =>
        deployWorkspaceDir(dir, {
          serverUrl: params.serverUrl as string,
          apiKey: params.apiKey as string,
          slug: typeof params.slug === "string" ? params.slug : undefined,
        }),
      );
      sendResponse(req.id, result);
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
      let runtime: GuestRuntime;
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
  installCrashGuards();
  const token = process.env.AAI_GUEST_TOKEN;
  if (!token) {
    console.error("AAI_GUEST_TOKEN is required");
    process.exit(1);
  }
  const port = Number(process.env.AAI_GUEST_PORT ?? "8080");
  // Modal gives the guest its own network namespace, so binding every
  // interface reaches no further than the sandbox — and a sandbox that cannot
  // be reached on its published port is the more damaging failure, hence the
  // default. AAI_GUEST_HOST is for the hosts that have no namespace around the
  // auth-free /websocket and so must pass loopback: the subprocess backend and
  // the integration tests, both of which run the harness as a bare child
  // process on the dev machine's own interfaces.
  const host = process.env.AAI_GUEST_HOST ?? "0.0.0.0";

  const state: HarnessState = {
    agent: null,
    createRuntime: null,
    env: Object.freeze({}),
    storageEnabled: false,
    runtime: null,
    activeSessions: 0,
    studio: null,
  };
  let hostSocket: WebSocket | null = null;
  let lastConnectedAt = Date.now();

  // The control channel keeps ws's default payload cap — bundle/load frames
  // run to ~30 MB (workers ship their runtime); client sessions get the
  // protocol's own cap (applied by
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
      if (!verifyBearer(req.headers.authorization, token)) {
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
  // This same entry doubles as the one-shot build child (see
  // studio-build.ts): the guest ships ONE artifact, so `buildWorkspaceDir`
  // re-spawns the harness with BUILD_CHILD_FLAG rather than a sibling script.
  // The bundler's module graph is imported only down this branch, and only in
  // that child — never in the long-lived server process.
  if (process.argv.includes(BUILD_CHILD_FLAG)) {
    const { runBuildChild } = await import("./studio-build-child.ts");
    await runBuildChild(process.argv.slice(2));
  } else {
    main();
  }
}
