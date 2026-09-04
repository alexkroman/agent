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
 * - **default (studio)** — the control-channel mode below,
 *   platform-versioned (always the current image), serving:
 *
 * A third mode, WARM-UP (`AAI_GUEST_WARMUP`), exists only for the image build: it
 * evaluates this module and exits 0 immediately, so a `NODE_COMPILE_CACHE`
 * populated by that run can be snapshotted INTO the harness image (see
 * aai-server/modal-harness-image.ts). It opens nothing, reads no bundle, and
 * needs no token — so it is checked before every other mode. It exists as a
 * declared mode rather than relying on the token check below to exit for us:
 * that worked by accident, and a warm-up that silently stopped compiling the
 * module would leave a cache that is merely empty, costing ~200ms on every
 * guest boot with nothing anywhere reporting it.
 *
 * - `/ws` — the host control channel, authenticated by the per-sandbox
 *   bearer token (AAI_GUEST_TOKEN, delivered via the exec env; the tunnel
 *   URL is public, so an upgrade without the token is rejected). JSON-RPC
 *   both ways: host→guest `studio/session-init`, `workspace/deploy`,
 *   `status`, and the `shutdown` notification; guest→host requests exist
 *   only for studio sessions (workspace sync, chat persistence). Bundle
 *   loading and tool trials are NOT RPC anymore: the studio's test_agent
 *   drives this harness's own loader/executor in-guest. There is no
 *   deploy-time inspection mode: the platform stores no agent config, so
 *   nothing ever asks a bundle to describe itself outside its own session.
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
 * `createRuntimeServer` `aai dev` runs (health, client-config, `/websocket`
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

import { pathToFileURL } from "node:url";
import { errorMessage } from "@alexkroman1/aai";
import { formatSchemaIssues, requestPath } from "@alexkroman1/aai/internal";
import { safeJsonParse } from "@alexkroman1/aai/utils";
import { createRuntimeServer } from "@alexkroman1/aai-runtime";
import { type WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { startGuestTracingDetached } from "./guest-tracing.ts";
import { mainAgent } from "./harness-agent-mode.ts";
import { verifyBearer } from "./harness-auth.ts";
import { emptyHarnessState, type HarnessState, lazyRuntime, loadBundle } from "./harness-bundle.ts";
import { installCrashGuards } from "./harness-crash-guards.ts";
import { installLeakWatch } from "./harness-leak-watch.ts";
import { captureGuestOutput } from "./harness-logs.ts";
import { resolveGuestPort } from "./harness-port.ts";
import {
  handleHostResponse,
  rejectAllPendingHostRequests,
  sendError,
  sendResponse,
  setHostSend,
} from "./harness-rpc.ts";
import { guestSdkVersion } from "./harness-sdk-version.ts";
import type { JsonRpcMessage, JsonRpcRequest, JsonRpcResponse } from "./harness-types.ts";

import { HARNESS_ORPHAN_POLL_MS, HARNESS_ORPHAN_TIMEOUT_MS } from "./limits.ts";
import { withBuildDir } from "./studio-build.ts";
import { handleStudioRequest } from "./studio-chat.ts";
import { deployWorkspaceDir } from "./studio-publish.ts";
import { initStudioSession } from "./studio-session.ts";
import { handleSessionInitRequest, SessionInitParamsSchema } from "./studio-session-init.ts";
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
  /**
   * Auto-preview deploys only — see `deployWorkspaceDir`. Additive and
   * optional, so an older host that never sends it still publishes (absent
   * reads as "production", the safe default).
   */
  allowPreviewSlug: z.boolean().optional(),
  /**
   * `--skipTypecheck`: deploy without the in-sandbox `tsc` gate. Additive and
   * optional — an older host that never sends it typechecks as before (absent
   * reads as "run the gate", the safe default). Mirrors `aai deploy`'s own
   * flag, so a studio Publish and a laptop deploy honor it identically.
   */
  skipTypecheck: z.boolean().optional(),
});

/**
 * Validate `req.params` against the handler's own schema, answering -32602 with
 * the schema's issues when they do not fit. Null means "already answered".
 *
 * One place decides what an invalid-params response looks like: the two cases
 * below each carried the same six lines, so the method name, the error code and
 * the `formatSchemaIssues` rendering were written out per handler.
 */
function parseParams<S extends z.ZodType>(req: JsonRpcRequest, schema: S): z.output<S> | null {
  const parsed = schema.safeParse(req.params);
  if (parsed.success) return parsed.data;
  sendError(
    req.id,
    -32_602,
    `${req.method}: invalid params — ${formatSchemaIssues(parsed.error.issues)}`,
  );
  return null;
}

/** Resolve and settle a single incoming JSON-RPC request. */
export async function handleRequest(req: JsonRpcRequest, state: HarnessState): Promise<void> {
  switch (req.method) {
    // Publish: run `aai deploy` IN THIS SANDBOX against a materialized
    // snapshot of the workspace (see studio-publish.ts) — the literal CLI,
    // so studio publishes and laptop deploys are one path, and the CLI's
    // output rides back for the chat.
    case "workspace/deploy": {
      const params = parseParams(req, DeployParamsSchema);
      if (params === null) break;
      const { files, serverUrl, apiKey, slug, allowPreviewSlug, skipTypecheck } = params;
      const result = await withBuildDir(files, materializeWorkspace, (dir) =>
        deployWorkspaceDir(dir, { serverUrl, apiKey, slug, allowPreviewSlug, skipTypecheck }),
      );
      sendResponse(req.id, result);
      break;
    }

    case "studio/session-init": {
      const params = parseParams(req, SessionInitParamsSchema);
      if (params === null) break;
      state.studio = await initStudioSession(params);
      sendResponse(req.id, { ok: true });
      break;
    }

    default:
      sendError(req.id, -32_601, `Method not found: ${req.method}`);
  }
}

/**
 * A notification frame as it arrives off the wire, where `method` is
 * UNVALIDATED — which is why this is not `JsonRpcNotification`. That type
 * promises `method: string`, so the guard below read as dead code and the spec
 * covering a malformed frame had to launder one past the checker with a cast.
 * A real `JsonRpcNotification` is still assignable.
 */
type IncomingNotification = { jsonrpc: "2.0"; method?: unknown; params?: unknown };

export function handleNotification(notif: IncomingNotification): void {
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
    handleNotification(msg);
    return;
  }
  // Request — handle concurrently so the socket keeps draining.
  const req = msg as JsonRpcRequest;
  void handleRequest(req, state).catch((err) => {
    sendError(req.id, -32_603, errorMessage(err));
  });
}

// ---- Servers -------------------------------------------------------------

export function main(): void {
  installCrashGuards();
  // After the crash guards and before the capture: Node warns about a listener
  // leak exactly ONCE per emitter and then never again, so this is what turns
  // that single line into a report that keeps pace with the leak. Its own
  // module doc carries the measurement.
  installLeakWatch();
  // Before anything else can write: this tees both process streams into the
  // ring `GET /manage/logs` serves, and every line produced before it is
  // installed is a line the studio's Logs pane cannot show.
  captureGuestOutput();
  // Warm-up mode: reaching here means this module has been compiled and
  // evaluated, which is the entire point (see the header). Exit 0 so the image
  // build can tell a populated cache from a broken warm-up.
  if (process.env.AAI_GUEST_WARMUP) {
    console.error("harness warm-up complete");
    process.exit(0);
  }
  // Span export, if an operator configured a collector — a no-op that imports
  // NOTHING otherwise. Detached rather than awaited, and the whole reason it is
  // ONE call is in `guest-tracing.ts`: boot latency is what this file is most
  // careful about, and `main` is synchronous.
  startGuestTracingDetached();
  const token = process.env.AAI_GUEST_TOKEN;
  if (!token) {
    console.error("AAI_GUEST_TOKEN is required");
    process.exit(1);
  }
  // Validated up front, in `harness-port.ts` so the rule has a test: an
  // unparseable AAI_GUEST_PORT would otherwise reach listen(NaN), which binds
  // an EPHEMERAL port — the guest looks healthy while the host dials the tunnel
  // for the published port until its deadline, and the spawn fails blaming the
  // dial, not the config.
  const port = resolveGuestPort(process.env.AAI_GUEST_PORT);
  if (typeof port === "string") {
    console.error(port);
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
      console.error(`agent-mode boot failed: ${errorMessage(err)}`);
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
  // createRuntimeServer's WebSocketServer).
  const controlWss = new WebSocketServer({ noServer: true });

  controlWss.on("connection", (ws) => {
    hostSocket = ws;
    setHostSend((msg) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    });

    ws.on("message", (data) => {
      const msg = safeJsonParse(String(data)) as JsonRpcMessage | undefined;
      if (msg === undefined) return; // malformed frame — skip
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
  const server = createRuntimeServer({
    runtime: lazyRuntime(state),
    request: (req, res, url, method) =>
      // Ahead of the chat surface: the install route is gated by the HOST
      // token and MINTS the chat token the chat surface checks, so it cannot
      // sit behind a session that may not exist yet (see studio-session-init.ts).
      handleSessionInitRequest(state, token, req, res, url, method) ||
      handleStudioRequest(state.studio, studioDeps, req, res, url, method),
    upgrade: (req, socket, head) => {
      const pathname = requestPath(req.url);
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
      // The SDK version rides the readiness line because a sandbox's boot output
      // is all anyone outside it ever sees, and the copy an agent RUNS is the one
      // beside the harness rather than the one bundled into it — see
      // `harness-sdk-version.ts` for the 500 that cost.
      console.error(`harness listening on ${host}:${port} (aai ${guestSdkVersion()})`);
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
