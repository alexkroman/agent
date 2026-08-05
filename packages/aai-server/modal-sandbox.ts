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
import {
  AlreadyExistsError,
  type Image,
  ModalClient,
  Probe,
  type SandboxCreateParams,
} from "modal";
import { debug } from "./_debug-log.ts";
import { keyedMemoAsync, memoAsync } from "./_memo.ts";
import { GUEST_READY_TIMEOUT_MS, raceGuestExit } from "./guest-readiness.ts";
import { GUEST_ROUTES, guestWsUrl } from "./guest-routes.ts";
import {
  createHarnessImageResolver,
  guestExecBaseEnv,
  HARNESS_REMOTE_PATH,
} from "./modal-harness-image.ts";
import {
  DEFAULT_SANDBOX_IDLE_TIMEOUT_MS,
  DEFAULT_SANDBOX_TIMEOUT_MS,
  guestSandboxResources,
} from "./modal-sandbox-env.ts";
import type { RpcWebSocket } from "./rpc-transport.ts";
import { SandboxNameTakenError } from "./sandbox-directory.ts";
import { resolveSandboxRole, type SpawnIdentity, sandboxTags } from "./sandbox-role.ts";
import type { WarmHarness } from "./sandbox-vm.ts";
import { type DialGuest, dialGuest, startGuestLogging, warmFromGuest } from "./warm-harness.ts";

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
  /**
   * A RUNNING sandbox by name, or null. This is the fleet-wide sandbox
   * directory (see sandbox-directory.ts) — Modal's control plane answers
   * "is some replica already serving this deploy?", which is what replaced a
   * lease table with a heartbeat.
   */
  lookupGuestSandbox(name: string): Promise<ModalSandboxLike | null>;
  /**
   * Resolve the snapshot image guests spawn from — building and publishing it
   * when this harness version has never been baked.
   *
   * Idempotent and memoized on the harness code, which is exactly what makes
   * it callable at boot: `createGuestSandbox` awaits the SAME promise, so a
   * spawn racing the prewarm joins it rather than starting a second build.
   */
  prepareGuestImage(code: string): Promise<void>;
};

// ── Configuration ────────────────────────────────────────────────────────────

/**
 * Default base image for guest sandboxes. Node only — the guest runs the
 * same runtime as the host, and Modal's sandbox is the security boundary.
 * The harness is baked on top via a one-time filesystem snapshot (see
 * `buildContext`). Override with `MODAL_SANDBOX_IMAGE` (pin a version tag in
 * production for reproducible guests).
 */
export const DEFAULT_SANDBOX_IMAGE = "node:26-slim";

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
export const GUEST_READINESS_PROBE = Probe.withTcp(GUEST_PORT, {
  intervalMs: READINESS_PROBE_INTERVAL_MS,
});

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

/**
 * Modal's duplicate-name refusal, in our vocabulary.
 *
 * Extracted because the ENTIRE fleet-wide-uniqueness design rests on this one
 * `instanceof`: a sandbox's name is what stops two replicas serving one deploy,
 * which is what let the lease table and its heartbeat be deleted. If Modal ever
 * stops throwing `AlreadyExistsError` here, the create silently becomes a
 * second sandbox instead of a routable "you lost the race" — no error, just a
 * duplicate. Only NAMED creates translate; an unnamed create has no race to
 * lose. Returns the error to throw rather than throwing, so the call site reads
 * as a plain rethrow.
 */
export function translateCreateError(err: unknown, name: string | undefined): unknown {
  return name && err instanceof AlreadyExistsError
    ? new SandboxNameTakenError(name, { cause: err })
    : err;
}

/**
 * Which image a spawn starts from: the deploy's PIN when it has one, else the
 * current harness image.
 *
 * A pinned tag is the image the agent was deployed against, so platform
 * upgrades never change the environment under an already-deployed bundle. An
 * unresolvable pin fails LOUDLY rather than silently substituting the current
 * image — that substitution is exactly the untested-environment drift pinning
 * exists to prevent, and hiding it behind a warning made a registry loss
 * invisible until an agent misbehaved. `SANDBOX_IGNORE_IMAGE_PINS=1` is the
 * operator kill switch for a registry loss, and it says so in the log.
 */
export async function resolveSpawnImage(opts: {
  imageTag: string | undefined;
  fromName: (tag: string) => Promise<Image>;
  current: () => Promise<Image>;
  env?: NodeJS.ProcessEnv;
}): Promise<Image> {
  const { imageTag, env = process.env } = opts;
  if (!imageTag) return await opts.current();
  if (env.SANDBOX_IGNORE_IMAGE_PINS === "1") {
    console.warn("SANDBOX_IGNORE_IMAGE_PINS=1: ignoring pinned harness image", { imageTag });
    return await opts.current();
  }
  return await opts.fromName(imageTag).catch((err: unknown) => {
    throw new Error(
      `pinned harness image ${imageTag} is unresolvable — redeploy the agent, ` +
        `or set SANDBOX_IGNORE_IMAGE_PINS=1 to force the current image: ${errorMessage(err)}`,
      { cause: err },
    );
  });
}

async function buildContext(): Promise<ModalSpawnContext> {
  if (!isModalConfigured()) throw modalRequiredError();
  const client = modalClient();
  const appName = process.env.MODAL_APP_NAME ?? DEFAULT_MODAL_APP_NAME;
  const app = await client.apps.fromName(appName, { createIfMissing: true });
  const baseTag = process.env.MODAL_SANDBOX_IMAGE ?? DEFAULT_SANDBOX_IMAGE;
  const baseImage = client.images.fromRegistry(baseTag);

  // Snapshot image with the harness baked in — see modal-harness-image.ts.
  const harnessImage = createHarnessImageResolver({ client, app, baseTag, baseImage });

  /**
   * Every named create funnels through here, so the "lost the race"
   * translation is a property of creating a NAMED guest sandbox rather than of
   * one caller's `.catch`. Both spawn paths pass a name now (agents via
   * `agentSandboxName`, studio via `studioSandboxName`); when the mapping
   * lived in the agent spawner, the studio got half the mechanism — its loser
   * surfaced a raw Modal error out of the broker route instead of the typed
   * one callers key on.
   */
  const create = async (image: Image, params: SandboxCreateParams) => {
    try {
      return await client.sandboxes.create(app, image, params);
    } catch (err) {
      throw translateCreateError(err, params.name);
    }
  };

  return {
    async createGuestSandbox(code, params, imageTag) {
      const image = await resolveSpawnImage({
        imageTag,
        fromName: (tag) => client.images.fromName(tag),
        current: () => harnessImage(code),
      });
      return create(image, params);
    },
    async prepareGuestImage(code) {
      await harnessImage(code);
    },
    async lookupGuestSandbox(name) {
      // `fromName` throws NotFoundError when no RUNNING sandbox holds the
      // name — which is the answer, not an error. Any other failure also
      // reads as "no sandbox": the caller then spawns, and a duplicate is
      // caught by the name itself at create time.
      try {
        return await client.sandboxes.fromName(appName, name);
      } catch {
        return null;
      }
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
 * Fire-and-forget warm-up of everything a spawn needs before it can ask Modal
 * for a sandbox, so the FIRST session pays for none of it: the Modal context
 * (app lookup, a gRPC round trip) and — given `harnessPath` — the guest
 * snapshot image.
 *
 * The image is the expensive half and the reason this takes a path at all.
 * Resolving it means reading the ~13 MB harness, a synchronous SHA-256 over it
 * for the content-addressed tag, and a lookup; on a harness version nobody has
 * published yet (i.e. right after every deploy) it means BUILDING — toolchain
 * layer, builder sandbox, 13 MB write, snapshot, publish. That landed on one
 * unlucky user's first voice session.
 *
 * Both stages are memoized, so a spawn racing this joins it rather than
 * starting a second build, and replicas racing each other are no worse than
 * the concurrent cold spawns that raced before. Failures only warn — the memo
 * resets and the next spawn retries as if it were the first caller.
 */
export function prewarmModal(harnessPath?: string): void {
  void (async () => {
    const ctx = await modalContext();
    if (!harnessPath) return;
    const started = Date.now();
    await ctx.prepareGuestImage(await harnessCode(harnessPath));
    debug("Guest harness image ready", { ms: Date.now() - started });
  })().catch((err: unknown) => {
    console.warn(`Modal prewarm failed: ${errorMessage(err)}`);
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
      ...(opts.name && { name: opts.name }),
      // The host dials in through this tunnel; the harness's bearer-token
      // check is what keeps the public tunnel URL from being an open door.
      encryptedPorts: [GUEST_PORT],
      readinessProbe: GUEST_READINESS_PROBE,
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
        // Compile cache + CONTAINED — see guestExecBaseEnv.
        env: {
          AAI_GUEST_TOKEN: token,
          AAI_GUEST_PORT: String(GUEST_PORT),
          ...guestExecBaseEnv(),
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
