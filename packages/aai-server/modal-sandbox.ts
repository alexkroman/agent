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
import { CONTAINED_ENV } from "@alexkroman1/aai/runtime";
import { ModalClient, type SandboxCreateParams } from "modal";
import { debug } from "./_debug-log.ts";
import { GUEST_ROUTES, guestWsUrl } from "./guest-routes.ts";
import { createHarnessImageResolver, HARNESS_REMOTE_PATH } from "./modal-harness-image.ts";
import {
  DEFAULT_SANDBOX_IDLE_TIMEOUT_MS,
  DEFAULT_SANDBOX_TIMEOUT_MS,
  parseSandboxLimitsFromEnv,
  parseSandboxRegionsFromEnv,
} from "./modal-sandbox-env.ts";
import type { RpcWebSocket } from "./rpc-transport.ts";
import type { WarmHarness } from "./sandbox-vm.ts";
import { type DialGuest, dialGuest, warmFromGuest } from "./warm-harness.ts";

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

// ── WarmHarness construction ─────────────────────────────────────────────────

/**
 * Wrap a Modal sandbox + dialed harness socket into the WarmHarness shape.
 * The lifecycle wiring (exit fan-out, memoized cleanup) lives in
 * warm-harness.ts, shared with the Apple container backend.
 */
function warmFromModal(
  sb: ModalSandboxLike,
  proc: ModalProcLike,
  ws: RpcWebSocket,
  origin: string,
): WarmHarness {
  return warmFromGuest({
    label: `modal:${sb.sandboxId}`,
    proc,
    terminate: () => sb.terminate(),
    ws,
    origin,
  });
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
    // Modal requires a reservation alongside each hard cap (`cpu` with
    // `cpuLimit`, `memoryMiB` with `memoryLimitMiB`) — a bare cap fails
    // sandbox creation. We pin reservation == cap: the operator's intent
    // behind SANDBOX_*_LIMIT is "exactly this much", not a burst range.
    ...(limits.memoryLimitMiB !== undefined && {
      memoryMiB: limits.memoryLimitMiB,
      memoryLimitMiB: limits.memoryLimitMiB,
    }),
    ...(limits.cpuLimit !== undefined && { cpu: limits.cpuLimit, cpuLimit: limits.cpuLimit }),
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
      // CONTAINED: a Modal Sandbox is a real container, so the network
      // builtins drop their SSRF screen — it guards nothing a tenant cannot
      // bypass with a raw fetch from their own tool code, and the container
      // holds no platform credentials. Deliberately NOT set by the
      // subprocess backend, whose "guest" is a child process on the
      // developer's own machine.
      env: {
        AAI_GUEST_TOKEN: token,
        AAI_GUEST_PORT: String(GUEST_PORT),
        [CONTAINED_ENV]: "1",
      },
    });

    const tunnels = await sb.tunnels();
    const tunnel = tunnels[GUEST_PORT];
    if (!tunnel) {
      throw new Error(`no tunnel for guest port ${GUEST_PORT}`);
    }
    // One origin; every guest surface (the bearer-gated control channel, the
    // PUBLIC auth-free client-session endpoint, the studio chat) derives from
    // it via GUEST_ROUTES.
    const origin = `wss://${tunnel.host}:${tunnel.port}`;
    const ws = await dial(guestWsUrl(origin, GUEST_ROUTES.control), token);

    debug("Modal sandbox spawned", {
      sandboxId: sb.sandboxId,
      slug: opts.slug ?? "pool",
      ms: Math.round(performance.now() - t0),
    });

    return warmFromModal(sb, proc, ws, origin);
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
  resetModalContext(): void {
    contextPromise = null;
    clientMemo = null;
    harnessCache.clear();
  },
};
