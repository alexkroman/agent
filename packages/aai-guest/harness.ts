// Copyright 2025 the AAI authors. MIT license.
/**
 * Node guest-side harness entrypoint — runs the COMPLETE agent.
 *
 * The harness embeds NO agent runtime: the worker bundle ships its own
 * (`__aaiCreateRuntime`, the user's installed SDK bundled in by the CLI
 * wrapper), so a deployed agent runs exactly the runtime version it was
 * built against and platform SDK drift cannot break it.
 *
 * TWO MODES, selected by the spawner via `AAI_GUEST_MODE` (behavior
 * selection only — never a security boundary; a hostile bundle can ignore
 * it, and gains nothing because capability is what the HOST delivers):
 *
 * - **agent** — the "guest is a server" contract: bundle + env arrive as
 *   files at exec time, no control channel exists, the platform's only
 *   surfaces are the public session endpoints plus the token-gated
 *   `/manage/*` pair, and lifecycle is guest-owned (see
 *   harness-agent-mode.ts). Deployed agents run this mode, on the harness
 *   image PINNED at deploy time.
 * - **default (studio/inspect/pool)** — the control-channel mode below,
 *   platform-versioned (always the current image), serving:
 *
 * A third one-shot mode, DESCRIBE (`AAI_DESCRIBE_BUNDLE_PATH`), imports a
 * bundle and prints its self-described config to stdout — deploy-time
 * config extraction with no server and no channel (see {@link mainDescribe}).
 *
 * - `/ws` — the host control channel, authenticated by the per-sandbox
 *   bearer token (AAI_GUEST_TOKEN, delivered via the exec env; the tunnel
 *   URL is public, so an upgrade without the token is rejected). JSON-RPC
 *   both ways: host→guest `studio/session-init`, `workspace/deploy`,
 *   `status`, and the `shutdown` notification; guest→host requests exist
 *   only for studio sessions (workspace sync, chat persistence). Bundle
 *   loading and tool trials are NOT RPC anymore: the studio's test_agent
 *   drives this harness's own loader/executor in-guest, and deploy-time
 *   inspection is the one-shot describe mode above.
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
 * first session, never at load — studio inspection loads carry an empty
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

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { formatSchemaIssues } from "@alexkroman1/aai/internal";
import { createServer, type SessionRuntime } from "@alexkroman1/aai/runtime";
import { type WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { createIdleController, createManageHandler, readAgentBoot } from "./harness-agent-mode.ts";
import { verifyBearer } from "./harness-auth.ts";
import {
  emptyHarnessState,
  ensureRuntime,
  type HarnessState,
  loadBundle,
} from "./harness-bundle.ts";
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
import {
  AGENT_IDLE_EXIT_MS,
  AGENT_IDLE_POLL_MS,
  HARNESS_ORPHAN_POLL_MS,
  HARNESS_ORPHAN_TIMEOUT_MS,
} from "./limits.ts";
import { withBuildDir } from "./studio-build.ts";
import { handleStudioRequest, initStudioSession } from "./studio-chat.ts";
import { deployWorkspaceDir } from "./studio-publish.ts";
import { materializeWorkspace } from "./studio-workspace-fs.ts";
import { executeTool } from "./trial.ts";

// ---- Control-channel dispatch -----------------------------------------------

// The wire params arrive as `unknown` — Zod at the receiving site is the
// contract. Each schema lives next to its handler and validates EVERY field
// of the params the handler forwards.

const DeployParamsSchema = z.object({
  files: z.record(z.string(), z.string()),
  serverUrl: z.string(),
  apiKey: z.string(),
  slug: z.string().optional(),
});

/** Mirrors `StudioSessionParams` (studio-chat.ts) field for field. */
const SessionInitParamsSchema = z.object({
  project: z.string(),
  files: z.record(z.string(), z.string()),
  apiKey: z.string(),
  chatToken: z.string().min(1),
  system: z.string(),
  model: z.string(),
  region: z.literal("eu").optional(),
  // Reaches `stepCountIs()` in studio-chat.ts — must be a positive integer.
  maxSteps: z.number().int().positive(),
});

/** Resolve and settle a single incoming JSON-RPC request. */
export async function handleRequest(req: JsonRpcRequest, state: HarnessState): Promise<void> {
  switch (req.method) {
    // Publish: run `aai deploy` IN THIS SANDBOX against a materialized
    // snapshot of the workspace (see studio-publish.ts) — the literal CLI,
    // so studio publishes and laptop deploys are one path, and the CLI's
    // output rides back for the chat.
    case "workspace/deploy": {
      const parsed = DeployParamsSchema.safeParse(req.params);
      if (!parsed.success) {
        sendError(
          req.id,
          -32_602,
          `workspace/deploy: invalid params — ${formatSchemaIssues(parsed.error.issues)}`,
        );
        break;
      }
      const { files, serverUrl, apiKey, slug } = parsed.data;
      const result = await withBuildDir(files, materializeWorkspace, (dir) =>
        deployWorkspaceDir(dir, { serverUrl, apiKey, slug }),
      );
      sendResponse(req.id, result);
      break;
    }

    case "studio/session-init": {
      const parsed = SessionInitParamsSchema.safeParse(req.params);
      if (!parsed.success) {
        sendError(
          req.id,
          -32_602,
          `studio/session-init: invalid params — ${formatSchemaIssues(parsed.error.issues)}`,
        );
        break;
      }
      state.studio = await initStudioSession(parsed.data);
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
  // Incoming response to a host RPC request we sent (studio sync/persist)
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
export function lazyRuntime(
  state: HarnessState,
  hooks: {
    /**
     * Pre-session refusal, checked before anything starts: return a close
     * code + reason to turn the session away (agent mode's drain refusal —
     * 1013 "try again" makes the client re-broker onto the replacement).
     * The one refusal path, shared with the runtime-build failure below.
     */
    refuse?: () => { code: number; reason: string } | null;
  } = {},
): SessionRuntime {
  return {
    startSession(ws, opts) {
      const socket = ws as unknown as WebSocket;
      const refusal = hooks.refuse?.();
      if (refusal) {
        socket.close(refusal.code, refusal.reason);
        return;
      }
      state.activeSessions++;
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

/**
 * AGENT MODE — the "guest is a server" contract (see harness-agent-mode.ts).
 * Everything arrives at exec time: the bundle and env are read (and the
 * bundle hash-verified) from files the spawner wrote into the sandbox, the
 * bundle is loaded BEFORE listen (so a 200 from /health means "ready"), and
 * there is NO host control channel — the platform's only surfaces are the
 * public session endpoints and the token-gated /manage/* pair. Lifecycle is
 * guest-owned: idle self-exit replaces the orphan timeout, and a drain
 * refuses new sessions then exits with the last one.
 */
async function mainAgent(port: number, host: string, token: string): Promise<void> {
  const state = emptyHarnessState();

  const rawIdle = Number(process.env.AAI_GUEST_IDLE_EXIT_MS ?? AGENT_IDLE_EXIT_MS);
  const idle = createIdleController({
    activeSessions: () => state.activeSessions,
    idleExitMs: Number.isFinite(rawIdle) && rawIdle >= 0 ? rawIdle : AGENT_IDLE_EXIT_MS,
    pollMs: AGENT_IDLE_POLL_MS,
  });

  const boot = await readAgentBoot();
  await loadBundle(state, { code: boot.code, env: boot.env });

  // A draining guest is detached from the broker, but a client holding its
  // old sessionUrl can still dial the tunnel directly — refuse with a "try
  // again" close so the client re-brokers onto the replacement.
  const runtime = lazyRuntime(state, {
    refuse: () => (idle.isDraining() ? { code: 1013, reason: "draining" } : null),
  });

  const server = createServer({
    runtime,
    // The guest is the authority on the agent's public client config: the
    // platform's `GET /:slug/client-config` broker PROXIES this server's
    // own `/client-config` for name/greeting, so the bundle's live agent
    // definition — interpreted by the bundle's own SDK — is what renders,
    // and the host never reads fields out of the stored config.
    ...(state.agent?.name !== undefined ? { name: state.agent.name } : {}),
    ...(state.agent?.greeting !== undefined ? { greeting: state.agent.greeting } : {}),
    request: createManageHandler({
      token,
      activeSessions: () => state.activeSessions,
      isDraining: idle.isDraining,
      startDrain: idle.startDrain,
    }),
  });
  await server.listen(port, host);
  console.error(`agent-mode harness listening on ${host}:${port}`);
}

/**
 * DESCRIBE MODE — deploy-time bundle inspection as a ONE-SHOT exec: import
 * the bundle named by `AAI_DESCRIBE_BUNDLE_PATH` (in the sandbox, never on
 * the host) and print the config it self-describes (`__aaiConfig`) as a
 * single JSON line on stdout — `{ ok: true, config }` or
 * `{ ok: false, error }`. The host parses the LAST stdout line, so a bundle
 * whose top level writes to stdout cannot corrupt the result. The exit code
 * mirrors `ok`. No token, no server, no channel: the process is the whole
 * contract, and the spawner tears the sandbox down when it exits.
 */
async function mainDescribe(bundlePath: string): Promise<void> {
  const state = emptyHarnessState();
  try {
    const code = await readFile(bundlePath, "utf-8");
    const loaded = await loadBundle(state, { code, env: {} });
    process.stdout.write(`\n${JSON.stringify({ ok: true, config: loaded.config })}\n`);
    process.exit(0);
  } catch (err) {
    process.stdout.write(`\n${JSON.stringify({ ok: false, error: errMsg(err) })}\n`);
    process.exit(1);
  }
}

function main(): void {
  installCrashGuards();
  // Describe mode runs before the token requirement: it opens no server and
  // answers no requests, so there is nothing for a token to gate.
  const describePath = process.env.AAI_DESCRIBE_BUNDLE_PATH;
  if (describePath) {
    void mainDescribe(describePath);
    return;
  }
  const token = process.env.AAI_GUEST_TOKEN;
  if (!token) {
    console.error("AAI_GUEST_TOKEN is required");
    process.exit(1);
  }
  // Validated up front: an unparseable AAI_GUEST_PORT would otherwise reach
  // listen(NaN), which binds an EPHEMERAL port — the guest looks healthy
  // while the host dials the tunnel for the published port until its
  // deadline, and the spawn fails blaming the dial, not the config.
  const rawPort = process.env.AAI_GUEST_PORT ?? "8080";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    console.error(`Invalid AAI_GUEST_PORT "${rawPort}" — expected an integer port`);
    process.exit(1);
  }
  // Modal gives the guest its own network namespace, so binding every
  // interface reaches no further than the sandbox — and a sandbox that cannot
  // be reached on its published port is the more damaging failure, hence the
  // default. AAI_GUEST_HOST is for the hosts that have no namespace around the
  // auth-free /websocket and so must pass loopback: the subprocess backend and
  // the integration tests, both of which run the harness as a bare child
  // process on the dev machine's own interfaces.
  const host = process.env.AAI_GUEST_HOST ?? "0.0.0.0";

  // Agent mode: boot-time provisioning, HTTP-only contract, no control
  // channel. A boot failure (missing/corrupt bundle, bad env file) exits
  // non-zero — the spawner sees the process die and fails the spawn loudly.
  if (process.env.AAI_GUEST_MODE === "agent") {
    mainAgent(port, host, token).catch((err: unknown) => {
      console.error(`agent-mode boot failed: ${errMsg(err)}`);
      process.exit(1);
    });
    return;
  }

  const state = emptyHarnessState();
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
    loadBundle: (code: string) => loadBundle(state, { code, env: {} }),
    executeTool: async (name: string, args: Record<string, unknown>) => {
      if (!state.agent) return "Tool error: agent not loaded";
      const response = await executeTool(
        state.agent,
        { name, args, sessionId: "studio-trial", state: null },
        { env: state.env },
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

  // A bind failure must exit with a nameable error: the subprocess backend's
  // port allocation is racy by design (warm-harness.ts releases the port
  // before the guest claims it), so EADDRINUSE is an anticipated path — left
  // uncaught it dies as a bare unhandledRejection while the host burns its
  // whole dial deadline and then blames the dial.
  server.listen(port, host).then(
    () => {
      console.error(`harness listening on ${host}:${port}`);
    },
    (err: unknown) => {
      console.error(`harness failed to listen on ${host}:${port}:`, err);
      process.exit(1);
    },
  );
}

// Only start the server when executed directly (not when imported in tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
