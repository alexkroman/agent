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
 * - **No secrets in the SANDBOX environment**: per-sandbox tokens ride the
 *   EXEC env (they die with the process), and a deployed agent's own env
 *   arrives as a file written into its sandbox and scrubbed after boot —
 *   studio sandboxes receive per-session data over the control channel.
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
import { ModalClient, Probe, type SandboxCreateParams } from "modal";
import { debug } from "./_debug-log.ts";
import { keyedMemoAsync, memoAsync } from "./_memo.ts";
import { GUEST_ROUTES, guestWsUrl } from "./guest-routes.ts";
import { createHarnessImageResolver, HARNESS_REMOTE_PATH } from "./modal-harness-image.ts";
import {
  DEFAULT_SANDBOX_IDLE_TIMEOUT_MS,
  DEFAULT_SANDBOX_TIMEOUT_MS,
  guestSandboxResources,
} from "./modal-sandbox-env.ts";
import type { RpcWebSocket } from "./rpc-transport.ts";
import { resolveSandboxRole, type SpawnIdentity, sandboxTags } from "./sandbox-role.ts";
import type { WarmHarness } from "./sandbox-vm.ts";
import {
  type AgentServerHandle,
  agentBootEnv,
  agentServerFromGuest,
  type DialGuest,
  dialGuest,
  GUEST_READY_TIMEOUT_MS,
  type GuestFetch,
  raceGuestExit,
  startGuestLogging,
  warmFromGuest,
} from "./warm-harness.ts";

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
  /**
   * Resolve once Modal's own readiness probe reports the sandbox ready — for
   * our guests, "the harness has bound its port" (see `GUEST_READINESS_PROBE`).
   */
  waitUntilReady(timeoutMs?: number): Promise<void>;
  exec(
    command: string[],
    params: { mode: "binary"; stdout: "pipe"; stderr: "pipe"; env?: Record<string, string> },
  ): Promise<ModalProcLike>;
  tunnels(timeoutMs?: number): Promise<Record<number, ModalTunnelLike>>;
  /**
   * Sandbox filesystem writes — how agent-mode boot artifacts (bundle + env)
   * land in the sandbox before exec. The same API the harness-image builder
   * uses, so the ~13 MB harness write is proven headroom for worker bundles.
   */
  filesystem: { writeText(data: string, remotePath: string): Promise<void> };
  terminate(): Promise<unknown>;
};

/**
 * The one operation spawning needs from Modal — injectable for tests.
 *
 * `createGuestSandbox` creates a sandbox with the given harness code present
 * at {@link HARNESS_REMOTE_PATH}, served from a baked snapshot image (built
 * once per harness version, published under a content-addressed tag).
 * `imageTag` pins the spawn to a specific published harness image — the one
 * recorded on the agent's row at deploy time — so a deployed bundle never
 * meets a harness/Node environment it wasn't deployed against. An
 * unresolvable pin FAILS the spawn loudly (silently substituting the current
 * image would run the bundle on an environment nobody tested it against —
 * the exact drift pinning exists to prevent); the operator kill switch
 * `SANDBOX_IGNORE_IMAGE_PINS=1` forces the current image for every spawn
 * when a registry loss makes that trade explicitly.
 */
export type ModalSpawnContext = {
  createGuestSandbox(
    code: string,
    params: SandboxCreateParams,
    imageTag?: string,
  ): Promise<ModalSandboxLike>;
};

// ── Configuration ────────────────────────────────────────────────────────────

/**
 * Default base image for guest sandboxes. Node only — the guest runs the
 * same runtime as the host, and Modal's sandbox is the security boundary.
 * The harness is baked on top via a one-time filesystem snapshot (see
 * `buildContext`). Override with `MODAL_SANDBOX_IMAGE` (pin a version tag in
 * production for reproducible guests).
 */
export const DEFAULT_SANDBOX_IMAGE = "node:24-slim";

/** Modal App the sandboxes are created under. Override with `MODAL_APP_NAME`. */
const DEFAULT_MODAL_APP_NAME = "aai-server";

/** Container port the harness WebSocket server listens on (tunneled). */
export const GUEST_PORT = 8080;

/** How often Modal evaluates the readiness probe inside the container. */
const READINESS_PROBE_INTERVAL_MS = 250;

/**
 * Readiness, as Modal evaluates it: is the harness's port open?
 *
 * This replaced the host polling the guest's public `/health` over the tunnel
 * every 250ms for up to two minutes. A TCP probe is exactly equivalent for
 * our guests, and that equivalence is a property of the harness's boot order,
 * not a guess: agent mode reads its boot files, HASH-VERIFIES and LOADS the
 * bundle, and only then calls `server.listen` — so the port opening means
 * "the bundle is loaded and sessions can be served", which is precisely what
 * a `/health` 200 meant. Keep it that way; a harness that listened first
 * would make this probe report ready before it could serve anything.
 *
 * Three things improve by moving the check into Modal:
 * - The probe runs INSIDE the container, on Modal's interval, instead of N
 *   HTTP requests crossing the public internet from whichever replica spawned.
 * - Readiness arrives over the control plane we already hold, so it does not
 *   depend on the guest being publicly reachable — which is what lets the
 *   control surfaces move off the public tunnel.
 * - One deadline, enforced in one place, instead of a poll loop with its own
 *   per-attempt timeout and last-error bookkeeping.
 */
const GUEST_READINESS_PROBE = (): Probe =>
  Probe.withTcp(GUEST_PORT, { intervalMs: READINESS_PROBE_INTERVAL_MS });

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
    async createGuestSandbox(code, params, imageTag) {
      // A pinned tag (the image the agent was DEPLOYED against) wins over
      // the current harness image, so platform upgrades never change the
      // environment under an already-deployed bundle. An unresolvable pin
      // fails LOUDLY rather than silently substituting the current image —
      // that substitution is exactly the untested-environment drift pinning
      // exists to prevent, and hiding it behind a warning made a registry
      // loss invisible until an agent misbehaved.
      if (imageTag && process.env.SANDBOX_IGNORE_IMAGE_PINS !== "1") {
        const pinned = await client.images.fromName(imageTag).catch((err: unknown) => {
          throw new Error(
            `pinned harness image ${imageTag} is unresolvable — redeploy the agent, ` +
              `or set SANDBOX_IGNORE_IMAGE_PINS=1 to force the current image: ${errorMessage(err)}`,
            { cause: err },
          );
        });
        return client.sandboxes.create(app, pinned, params);
      }
      if (imageTag) {
        console.warn("SANDBOX_IGNORE_IMAGE_PINS=1: ignoring pinned harness image", { imageTag });
      }
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
export const modalContext = memoAsync(buildContext);

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

const harnessCache = keyedMemoAsync<string>();

/** Read (and memoize) the built guest harness — it is stable per process. */
export function harnessCode(harnessPath: string): Promise<string> {
  return harnessCache(harnessPath, () => readFile(harnessPath, "utf-8"));
}

// ── WarmHarness construction ─────────────────────────────────────────────────

/**
 * Wrap a Modal sandbox + dialed harness socket into the WarmHarness shape.
 * The lifecycle wiring (exit fan-out, memoized cleanup) lives in
 * warm-harness.ts, shared with the subprocess backend.
 */
function warmFromModal(
  sb: ModalSandboxLike,
  proc: ModalProcLike,
  ws: RpcWebSocket,
  origin: string,
  token: string,
): WarmHarness {
  return warmFromGuest({
    proc,
    terminate: () => sb.terminate(),
    ws,
    origin,
    token,
  });
}

// ── Spawning ─────────────────────────────────────────────────────────────────

/**
 * Spawn a warm Node harness in a fresh Modal sandbox and dial its WebSocket.
 * The returned WarmHarness has a running harness process and a connected RPC
 * channel, but no listeners attached and no bundle loaded.
 *
 * `slug` and `role` are attached as sandbox tags for observability only
 * (see sandbox-role.ts); the security boundary is Modal's sandbox isolation
 * + network policy.
 */
export async function spawnModalWarm(
  opts: { harnessPath: string; imageTag?: string | undefined } & SpawnIdentity,
  ctx?: ModalSpawnContext,
  dial: DialGuest = dialGuest,
): Promise<WarmHarness> {
  const [code, context] = await Promise.all([
    harnessCode(opts.harnessPath),
    ctx ? Promise.resolve(ctx) : modalContext(),
  ]);
  const { limits, resourceParams } = guestSandboxResources(process.env);
  const role = resolveSandboxRole(opts);

  const t0 = performance.now();
  const sb = await context.createGuestSandbox(
    code,
    {
      // Explicit idle entrypoint: the exec'd harness is what holds the sandbox
      // active, so its exit is what starts the idle timer.
      command: ["sleep", "infinity"],
      // The host dials in through this tunnel; the harness's bearer-token
      // check is what keeps the public tunnel URL from being an open door.
      encryptedPorts: [GUEST_PORT],
      readinessProbe: GUEST_READINESS_PROBE(),
      timeoutMs: limits.timeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS,
      idleTimeoutMs: limits.idleTimeoutMs ?? DEFAULT_SANDBOX_IDLE_TIMEOUT_MS,
      ...resourceParams,
      tags: sandboxTags(role, opts.slug),
    },
    opts.imageTag,
  );
  try {
    // The per-sandbox bearer token rides the EXEC env — never the sandbox
    // env, where it would outlive the process and show in sandbox metadata.
    const token = randomBytes(32).toString("hex");
    // The tunnel lookup doesn't depend on the exec — dialGuest already
    // retries while the harness boots — so save a Modal control-plane round
    // trip by running the two together.
    const [proc, tunnels] = await Promise.all([
      sb.exec(["node", HARNESS_REMOTE_PATH], {
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
      }),
      sb.tunnels(),
    ]);
    // Before the dial: a harness that dies during boot must still get its
    // stderr into the host log (see startGuestLogging).
    startGuestLogging(proc, `modal:${sb.sandboxId}`);
    const tunnel = tunnels[GUEST_PORT];
    if (!tunnel) {
      throw new Error(`no tunnel for guest port ${GUEST_PORT}`);
    }
    // One origin; every guest surface (the bearer-gated control channel, the
    // PUBLIC auth-free client-session endpoint, the studio chat) derives from
    // it via GUEST_ROUTES.
    const origin = `wss://${tunnel.host}:${tunnel.port}`;
    // Wait for Modal's probe rather than discovering readiness by failed
    // dials: the dial's own retry stays as the backstop, but on the happy
    // path it now connects first try instead of polling the boot.
    await raceGuestExit(sb.waitUntilReady(GUEST_READY_TIMEOUT_MS), proc);
    const ws = await dial(guestWsUrl(origin, GUEST_ROUTES.control), token);

    debug("Modal sandbox spawned", {
      sandboxId: sb.sandboxId,
      role,
      slug: opts.slug ?? "inspect",
      ms: Math.round(performance.now() - t0),
    });

    return warmFromModal(sb, proc, ws, origin, token);
  } catch (err) {
    // Never leak a sandbox whose harness failed to start.
    await sb.terminate().catch(() => undefined);
    throw new Error(`Modal sandbox spawn failed: ${errorMessage(err)}`, { cause: err });
  }
}

// ── Agent-server spawning (the HTTP-only contract) ───────────────────────────

/** Where agent-mode boot artifacts land in the sandbox (written pre-exec). */
export const AGENT_BUNDLE_REMOTE_PATH = "/tmp/aai-agent-bundle.mjs";
const AGENT_ENV_REMOTE_PATH = "/tmp/aai-agent-env.json";

/**
 * Spawn one DEPLOYED AGENT as a server in a fresh Modal sandbox: create from
 * the deploy's pinned image (falling back to current — see
 * `createGuestSandbox`), write the bundle and agent env into the sandbox,
 * exec the harness in agent mode, and wait for its public `/health` — a 200
 * means the bundle is loaded and sessions can be served. No control channel
 * is dialed; the returned handle's whole surface is HTTP + terminate.
 */
export async function spawnModalAgentServer(
  opts: {
    harnessPath: string;
    slug: string;
    workerCode: string;
    workerSha256: string;
    agentEnv: Record<string, string>;
    imageTag?: string | undefined;
  },
  ctx?: ModalSpawnContext,
  fetchFn?: GuestFetch,
): Promise<AgentServerHandle> {
  const [code, context] = await Promise.all([
    harnessCode(opts.harnessPath),
    ctx ? Promise.resolve(ctx) : modalContext(),
  ]);
  const { limits, resourceParams } = guestSandboxResources(process.env);
  const role = resolveSandboxRole({ slug: opts.slug });

  const t0 = performance.now();
  const sb = await context.createGuestSandbox(
    code,
    {
      command: ["sleep", "infinity"],
      encryptedPorts: [GUEST_PORT],
      readinessProbe: GUEST_READINESS_PROBE(),
      timeoutMs: limits.timeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS,
      idleTimeoutMs: limits.idleTimeoutMs ?? DEFAULT_SANDBOX_IDLE_TIMEOUT_MS,
      ...resourceParams,
      tags: sandboxTags(role, opts.slug),
    },
    opts.imageTag,
  );
  try {
    // Boot artifacts land on the sandbox filesystem BEFORE exec — the guest
    // reads (and hash-verifies) them at boot; nothing arrives over a channel.
    await sb.filesystem.writeText(opts.workerCode, AGENT_BUNDLE_REMOTE_PATH);
    await sb.filesystem.writeText(JSON.stringify(opts.agentEnv), AGENT_ENV_REMOTE_PATH);

    const token = randomBytes(32).toString("hex");
    const [proc, tunnels] = await Promise.all([
      sb.exec(["node", HARNESS_REMOTE_PATH], {
        mode: "binary",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...agentBootEnv({
            token,
            port: GUEST_PORT,
            bundlePath: AGENT_BUNDLE_REMOTE_PATH,
            bundleSha256: opts.workerSha256,
            envPath: AGENT_ENV_REMOTE_PATH,
          }),
          [CONTAINED_ENV]: "1",
        },
      }),
      sb.tunnels(),
    ]);
    // Before the readiness poll: a bundle that throws at load exits here, and
    // its stderr IS the diagnosis (see startGuestLogging).
    startGuestLogging(proc, `modal:${sb.sandboxId}`);
    const tunnel = tunnels[GUEST_PORT];
    if (!tunnel) {
      throw new Error(`no tunnel for guest port ${GUEST_PORT}`);
    }
    const origin = `wss://${tunnel.host}:${tunnel.port}`;
    // Modal's readiness probe, raced against guest-process exit: a bundle
    // that throws at load exits here, and its stderr IS the diagnosis.
    await raceGuestExit(sb.waitUntilReady(GUEST_READY_TIMEOUT_MS), proc);

    debug("Modal agent server spawned", {
      sandboxId: sb.sandboxId,
      slug: opts.slug,
      ms: Math.round(performance.now() - t0),
    });

    return agentServerFromGuest({
      proc,
      terminate: () => sb.terminate(),
      origin,
      token,
      fetchFn,
    });
  } catch (err) {
    // Never leak a sandbox whose agent server failed to come up.
    await sb.terminate().catch(() => undefined);
    throw new Error(`Modal agent-server spawn failed: ${errorMessage(err)}`, { cause: err });
  }
}

// ── Test-only internals ──────────────────────────────────────────────────────

/** @internal Exposed for unit tests only. */
export const _internals = {
  warmFromModal,
  resetModalContext(): void {
    modalContext.reset();
    clientMemo = null;
    harnessCache.clear();
  },
};
