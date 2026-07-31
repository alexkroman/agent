// Copyright 2026 the AAI authors. MIT license.
/**
 * Modal-backed sandbox spawning.
 *
 * Every guest harness runs in a [Modal Sandbox](https://modal.com/docs/guide/sandbox)
 * — a remote, isolated container managed by Modal's infrastructure. The
 * sandbox is created from a snapshot image with the harness baked in (built
 * once per harness version — see `buildContext`), the harness is exec'd as a
 * Node process serving a WebSocket, and the host dials that socket through
 * the sandbox's Modal tunnel. JSON-RPC 2.0 messages flow both ways over the
 * socket (see rpc-transport.ts).
 *
 * Security properties:
 * - **The tunnel is public but the harness is not**: the host mints a
 *   per-sandbox bearer token, delivers it via the exec's env (never the
 *   sandbox's), and the harness rejects unauthenticated upgrades.
 * - **No secrets in the guest environment**: agent env is delivered via the
 *   `bundle/load` RPC params, never as sandbox environment variables.
 * - **No host filesystem**: the sandbox sees only the baked guest image.
 * - **Resource limits**: memory/CPU caps map onto Modal's per-sandbox
 *   `memoryLimitMiB`/`cpuLimit` options.
 *
 * Guest runtime is Node — the same runtime as the host and `aai dev`, so
 * tool code behaves identically everywhere. The Modal sandbox (not a
 * language runtime permission model) is the security boundary.
 *
 * Credentials: `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET` (or a `~/.modal.toml`
 * profile — the SDK resolves both). There is no fallback backend: without
 * Modal credentials, sandbox creation fails loudly in dev and prod alike.
 */

import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { errorMessage } from "@alexkroman1/aai";
import { ModalClient, type SandboxCreateParams } from "modal";
import { WebSocket } from "ws";
import { debug } from "./_debug-log.ts";
import { createHarnessImageResolver, HARNESS_REMOTE_PATH } from "./modal-harness-image.ts";
import {
  DEFAULT_SANDBOX_IDLE_TIMEOUT_MS,
  DEFAULT_SANDBOX_TIMEOUT_MS,
  parseSandboxLimitsFromEnv,
  parseSandboxRegionsFromEnv,
} from "./modal-sandbox-env.ts";
import type { GuestRpcSchema } from "./rpc-schemas.ts";
import { createRpcConnection, type RpcWebSocket } from "./rpc-transport.ts";
import type { WarmHarness } from "./sandbox-vm.ts";

// ── Structural Modal types ───────────────────────────────────────────────────
// Minimal shapes of the Modal SDK objects we touch. Structural rather than the
// SDK classes so unit tests can inject fakes without constructing gRPC
// clients; the real `Sandbox`/`ContainerProcess` satisfy them.

export type ModalProcLike = {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  /** Resolves with the exit code once the process finishes. */
  wait(): Promise<number>;
};

export type ModalTunnelLike = {
  host: string;
  port: number;
};

export type ModalSandboxLike = {
  sandboxId: string;
  exec(
    command: string[],
    params: { mode: "binary"; stdout: "pipe"; stderr: "pipe"; env?: Record<string, string> },
  ): Promise<ModalProcLike>;
  tunnels(timeoutMs?: number): Promise<Record<number, ModalTunnelLike>>;
  terminate(): Promise<unknown>;
};

/**
 * The one operation spawning needs from Modal — injectable for tests.
 *
 * `createGuestSandbox` creates a sandbox with the given harness code present
 * at {@link HARNESS_REMOTE_PATH}, served from a baked snapshot image (built
 * once per harness version, published under a content-addressed tag).
 */
export type ModalSpawnContext = {
  createGuestSandbox(code: string, params: SandboxCreateParams): Promise<ModalSandboxLike>;
};

// ── Configuration ────────────────────────────────────────────────────────────

/**
 * Default base image for guest sandboxes. Node only — the guest runs the
 * same runtime as the host, and Modal's sandbox is the security boundary.
 * The harness is baked on top via a one-time filesystem snapshot (see
 * `buildContext`). Override with `MODAL_SANDBOX_IMAGE` (pin a version tag in
 * production for reproducible guests).
 */
const DEFAULT_SANDBOX_IMAGE = "node:24-slim";

/** Modal App the sandboxes are created under. Override with `MODAL_APP_NAME`. */
const DEFAULT_MODAL_APP_NAME = "aai-server";

/** Container port the harness WebSocket server listens on (tunneled). */
export const GUEST_PORT = 8080;

/** Budget for the harness WebSocket to become dialable after exec. */
const GUEST_DIAL_TIMEOUT_MS = 30_000;

/** Delay between dial attempts while the harness server boots. */
const GUEST_DIAL_RETRY_MS = 250;

export function modalRequiredError(): Error {
  return new Error(
    "Modal credentials are required to run agent sandboxes. " +
      "Set MODAL_TOKEN_ID and MODAL_TOKEN_SECRET (or configure ~/.modal.toml) — " +
      "see https://modal.com/docs/reference/modal.config. " +
      "Running untrusted agent code without sandbox isolation is not allowed.",
  );
}

// One ModalClient per process — construction only resolves credentials
// (env vars / ~/.modal.toml), so `isModalConfigured` and `buildContext`
// share the instance.
let clientMemo: ModalClient | null = null;

function modalClient(): ModalClient {
  clientMemo ??= new ModalClient();
  return clientMemo;
}

/** True when the Modal SDK can resolve credentials (env vars or ~/.modal.toml). */
export function isModalConfigured(): boolean {
  try {
    const client = modalClient();
    return Boolean(client.profile.tokenId && client.profile.tokenSecret);
  } catch {
    return false;
  }
}

// ── Modal context (client/app/image, resolved once) ──────────────────────────

let contextPromise: Promise<ModalSpawnContext> | null = null;

async function buildContext(): Promise<ModalSpawnContext> {
  if (!isModalConfigured()) throw modalRequiredError();
  const client = modalClient();
  const appName = process.env.MODAL_APP_NAME ?? DEFAULT_MODAL_APP_NAME;
  const app = await client.apps.fromName(appName, { createIfMissing: true });
  const baseTag = process.env.MODAL_SANDBOX_IMAGE ?? DEFAULT_SANDBOX_IMAGE;
  const baseImage = client.images.fromRegistry(baseTag);

  // Snapshot image with the harness baked in — see modal-harness-image.ts.
  const harnessImage = createHarnessImageResolver({ client, app, baseTag, baseImage });

  return {
    async createGuestSandbox(code, params) {
      const image = await harnessImage(code);
      return client.sandboxes.create(app, image, params);
    },
  };
}

/**
 * Resolve the shared Modal context. Memoized; a failure clears the memo so
 * the next spawn retries (a transient control-plane error must not disable
 * sandboxing for the process lifetime).
 */
function modalContext(): Promise<ModalSpawnContext> {
  contextPromise ??= buildContext().catch((err: unknown) => {
    contextPromise = null;
    throw err;
  });
  return contextPromise;
}

/**
 * Fire-and-forget warm-up of the memoized Modal context (app lookup/creation
 * is a gRPC round trip that would otherwise land on the first session's cold
 * start). A failure only warns — the next spawn retries via the memo reset.
 */
export function prewarmModal(): void {
  void modalContext().catch((err: unknown) => {
    console.warn(`Modal context prewarm failed: ${errorMessage(err)}`);
  });
}

// ── Harness code cache ───────────────────────────────────────────────────────

const harnessCache = new Map<string, Promise<string>>();

/** Read (and memoize) the built guest harness — it is stable per process. */
function harnessCode(harnessPath: string): Promise<string> {
  let cached = harnessCache.get(harnessPath);
  if (!cached) {
    cached = readFile(harnessPath, "utf-8").catch((err: unknown) => {
      harnessCache.delete(harnessPath);
      throw err;
    });
    harnessCache.set(harnessPath, cached);
  }
  return cached;
}

// ── Guest process logging ────────────────────────────────────────────────────

/**
 * Cap on stream bytes logged per sandbox. Guest stack traces are diagnostic
 * gold, but a guest looping on writes must not flood the host's logs — past
 * the cap the stream keeps draining silently (never stop consuming, or the
 * guest wedges on its next write).
 */
const MAX_STREAM_LOG_BYTES = 64 * 1024;

async function drainProcStream(stream: ReadableStream<Uint8Array>, label: string): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let logged = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (logged >= MAX_STREAM_LOG_BYTES) continue; // keep draining, stop logging
      logged += value.byteLength;
      const text = decoder.decode(value, { stream: true }).trimEnd();
      if (text) console.warn(`${label}: ${text}`);
    }
  } catch {
    // Peer died mid-read; process exit handling covers teardown.
  }
}

// ── Guest WebSocket dial ─────────────────────────────────────────────────────

/** How the host reaches a spawned harness — injectable for tests. */
export type DialGuest = (url: string, token: string) => Promise<RpcWebSocket>;

function connectOnce(url: string, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
    ws.once("open", () => resolve(ws));
    ws.once("error", (err) => reject(err));
    ws.once("unexpected-response", (_req, res) => {
      reject(new Error(`guest WebSocket dial rejected: HTTP ${res.statusCode}`));
    });
  });
}

/**
 * Dial the harness WebSocket through its tunnel, retrying while the harness
 * server boots (the tunnel exists before the exec'd process listens, so
 * early attempts are refused/reset).
 */
async function dialGuest(url: string, token: string): Promise<RpcWebSocket> {
  const deadline = Date.now() + GUEST_DIAL_TIMEOUT_MS;
  for (;;) {
    try {
      return await connectOnce(url, token);
    } catch (err) {
      if (Date.now() >= deadline) {
        throw new Error(
          `guest WebSocket not dialable after ${GUEST_DIAL_TIMEOUT_MS}ms: ${errorMessage(err)}`,
          { cause: err },
        );
      }
      await new Promise((r) => setTimeout(r, GUEST_DIAL_RETRY_MS));
    }
  }
}

// ── WarmHarness construction ─────────────────────────────────────────────────

/** Wrap a Modal sandbox + dialed harness socket into the WarmHarness shape. */
function warmFromModal(
  sb: ModalSandboxLike,
  proc: ModalProcLike,
  ws: RpcWebSocket,
  sessionUrl: string,
): WarmHarness {
  void drainProcStream(proc.stdout, `[modal:${sb.sandboxId}] stdout`);
  void drainProcStream(proc.stderr, `[modal:${sb.sandboxId}] stderr`);

  const conn = createRpcConnection<GuestRpcSchema>(ws);

  const exitListeners: (() => void)[] = [];
  let dead = false;
  const notifyExit = (): void => {
    if (dead) return;
    dead = true;
    for (const cb of exitListeners) {
      try {
        cb();
      } catch {
        // Listener errors must not crash the host
      }
    }
  };
  // The harness process ending — clean exit, sandbox timeout, OOM kill,
  // terminate() — all settle wait(). A dropped socket means the same thing
  // from the host's perspective: this harness is unusable (the host never
  // redials) and its guest self-exits on the orphan timeout.
  proc.wait().then(notifyExit, notifyExit);
  ws.on("close", notifyExit);

  let cleanupPromise: Promise<void> | null = null;
  const cleanup = (): Promise<void> => {
    // Memoized: a concurrent second caller must wait for the sandbox to
    // actually be terminated, not return before the first caller finished.
    cleanupPromise ??= (async () => {
      notifyExit();
      try {
        await sb.terminate();
      } catch {
        // Best-effort — the sandbox may already be gone (timeout, crash).
      }
    })();
    return cleanupPromise;
  };

  return {
    conn,
    sessionUrl,
    cleanup,
    alive: () => !dead,
    onExit: (cb) => {
      // A harness can die between spawn resolution and this registration —
      // notifyExit walks the listener list exactly once, so a listener added
      // afterwards would never fire and (for the pool) a dead harness would
      // sit in `ready` unevicted until an acquire skipped it. Fire it now.
      if (dead) {
        try {
          cb();
        } catch {
          // Listener errors must not crash the host
        }
        return;
      }
      exitListeners.push(cb);
    },
    async [Symbol.asyncDispose]() {
      // Best-effort: on a dead guest the notification is dropped, and
      // terminate() may find the sandbox already gone — both fine.
      void conn.sendNotification("shutdown");
      conn.dispose();
      await cleanup().catch(() => undefined);
    },
  };
}

// ── Spawning ─────────────────────────────────────────────────────────────────

/**
 * Spawn a warm Node harness in a fresh Modal sandbox and dial its WebSocket.
 * The returned WarmHarness has a running harness process and a connected RPC
 * channel, but no listeners attached and no bundle loaded.
 *
 * `slug` is attached as a sandbox tag for observability only; the security
 * boundary is Modal's sandbox isolation + network policy.
 */
export async function spawnModalWarm(
  opts: { harnessPath: string; slug?: string },
  ctx?: ModalSpawnContext,
  dial: DialGuest = dialGuest,
): Promise<WarmHarness> {
  const [code, context] = await Promise.all([
    harnessCode(opts.harnessPath),
    ctx ? Promise.resolve(ctx) : modalContext(),
  ]);
  const limits = parseSandboxLimitsFromEnv(process.env);
  const regions = parseSandboxRegionsFromEnv(process.env);

  const t0 = performance.now();
  const sb = await context.createGuestSandbox(code, {
    // Explicit idle entrypoint: the exec'd harness is what holds the sandbox
    // active, so its exit is what starts the idle timer.
    command: ["sleep", "infinity"],
    // The host dials in through this tunnel; the harness's bearer-token
    // check is what keeps the public tunnel URL from being an open door.
    encryptedPorts: [GUEST_PORT],
    timeoutMs: limits.timeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS,
    idleTimeoutMs: limits.idleTimeoutMs ?? DEFAULT_SANDBOX_IDLE_TIMEOUT_MS,
    ...(limits.memoryLimitMiB !== undefined && { memoryLimitMiB: limits.memoryLimitMiB }),
    ...(limits.cpuLimit !== undefined && { cpuLimit: limits.cpuLimit }),
    // Co-locate guests with the host — see parseSandboxRegionsFromEnv.
    ...(regions && { regions }),
    tags: { service: "aai-guest", slug: opts.slug ?? "pool" },
  });
  try {
    // The per-sandbox bearer token rides the EXEC env — never the sandbox
    // env, where it would outlive the process and show in sandbox metadata.
    const token = randomBytes(32).toString("hex");
    const proc = await sb.exec(["node", HARNESS_REMOTE_PATH], {
      mode: "binary",
      stdout: "pipe",
      stderr: "pipe",
      env: { AAI_GUEST_TOKEN: token, AAI_GUEST_PORT: String(GUEST_PORT) },
    });

    const tunnels = await sb.tunnels();
    const tunnel = tunnels[GUEST_PORT];
    if (!tunnel) {
      throw new Error(`no tunnel for guest port ${GUEST_PORT}`);
    }
    const ws = await dial(`wss://${tunnel.host}:${tunnel.port}/ws`, token);
    // The PUBLIC client-session endpoint on the same tunnel — handed to
    // browsers by the platform's client-config broker. Auth-free by design
    // (parity with the platform's always-public agent WebSocket).
    const sessionUrl = `wss://${tunnel.host}:${tunnel.port}/websocket`;

    debug("Modal sandbox spawned", {
      sandboxId: sb.sandboxId,
      slug: opts.slug ?? "pool",
      ms: Math.round(performance.now() - t0),
    });

    return warmFromModal(sb, proc, ws, sessionUrl);
  } catch (err) {
    // Never leak a sandbox whose harness failed to start.
    await sb.terminate().catch(() => undefined);
    throw new Error(`Modal sandbox spawn failed: ${errorMessage(err)}`, { cause: err });
  }
}

// ── Test-only internals ──────────────────────────────────────────────────────

/** @internal Exposed for unit tests only. */
export const _internals = {
  warmFromModal,
  drainProcStream,
  resetModalContext(): void {
    contextPromise = null;
    clientMemo = null;
    harnessCache.clear();
  },
};
