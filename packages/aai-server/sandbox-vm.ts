// Copyright 2025 the AAI authors. MIT license.
/**
 * Sandbox implementation backed by Modal Sandboxes (see modal-sandbox.ts) in
 * production, and in local dev by a plain child process
 * (subprocess-sandbox.ts). `sandbox-backend.ts` owns the selection
 * policy.
 *
 * Deployed agents spawn as SERVERS ({@link spawnAgentServer}): boot
 * artifacts delivered at exec time, readiness = the guest's public
 * `/health`, and the host's whole ongoing surface is the token-gated
 * `/manage/*` pair — no control channel exists on an agent sandbox.
 *
 * The control-channel machinery below ({@link spawnWarmHarness},
 * {@link acquireWarmHarness}, {@link describeBundle}) remains for the
 * STUDIO side — coding-agent sessions, Publish, deploy-time bundle
 * inspection, and the warm pool — which always runs the CURRENT harness
 * image and may change atomically with the server.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { keyedMemoAsync } from "./_memo.ts";
import { resolveHarnessPath } from "./constants.ts";
import { harnessImageTag, resolveToolchainSpecs } from "./modal-harness-image.ts";
import { DEFAULT_SANDBOX_IMAGE, spawnModalAgentServer, spawnModalWarm } from "./modal-sandbox.ts";
import type { BundleLoadResult, GuestConnection } from "./rpc-schemas.ts";
import { resolveSandboxBackend } from "./sandbox-backend.ts";
import type { SandboxPool } from "./sandbox-pool.ts";
import {
  resolveSandboxRole,
  type SandboxRole,
  type SpawnIdentity,
  sandboxTags,
} from "./sandbox-role.ts";
import { spawnSubprocessAgentServer, spawnSubprocessWarm } from "./subprocess-sandbox.ts";
import type { AgentServerHandle } from "./warm-harness.ts";

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * A spawned harness whose guest process is running and whose RPC connection
 * is dialed, but which has NOT yet received a bundle/load. Used by the
 * sandbox pool for warm starts.
 *
 * `listen()` has not been called on the connection yet — the per-agent
 * configuration step (handler registration + bundle/load) will call it
 * after handlers are registered.
 */
export type WarmHarness = {
  conn: GuestConnection;
  /**
   * The guest's origin (`ws(s)://host:port`). Every guest surface derives
   * from this via GUEST_ROUTES, rather than each consumer rebuilding URLs.
   */
  guestOrigin: string;
  /** Public client-session endpoint on the sandbox's tunnel. */
  sessionUrl: string;
  cleanup: () => Promise<void>;
  /** True while the underlying guest process is alive. */
  alive: () => boolean;
  /** Register a one-shot listener for guest exit (for pool reaping). */
  onExit: (cb: () => void) => void;
  /**
   * Replace the backend's observability tags (Modal only — see
   * sandbox-role.ts). Used to re-tag a pooled sandbox with its real
   * role/slug on acquire; creation-time tags say "pool".
   */
  setTags?: ((tags: Record<string, string>) => Promise<void>) | undefined;
  [Symbol.asyncDispose](): Promise<void>;
};

export type AgentSpawnOptions = {
  slug: string;
  workerCode: string;
  env: Record<string, string>;
  harnessPath: string;
  /**
   * The harness snapshot image the agent was DEPLOYED against
   * (`harness_image_tag` on its agents row). When set, the Modal backend
   * spawns from that image instead of the current one, so a platform
   * upgrade never changes the runtime environment under an
   * already-deployed bundle. Ignored by the subprocess backend.
   */
  imageTag?: string | undefined;
};

// ── Warm-harness spawning ────────────────────────────────────────────────────

/**
 * Spawn a warm Node harness in a fresh sandbox. The returned WarmHarness has
 * a running guest process and a dialed RPC channel, but no listeners
 * attached and no bundle loaded.
 *
 * Single dispatch point for the backend policy, used by both the sandbox pool
 * and on-demand sandbox creation. `resolveSandboxBackend` (see
 * `sandbox-backend.ts`) picks Modal in production and the isolation-free
 * `subprocess` backend in local dev. Spawning fails loudly when the chosen
 * backend's prerequisites are absent — there is no fallback *between* backends
 * at spawn time, only at selection time, and selection can never reach
 * `subprocess` outside local dev.
 *
 * `slug`/`role` only affect the sandbox's observability tags (pool spawns
 * default to role "pool", agent slugs infer "agent"/"preview" — see
 * sandbox-role.ts); under Modal the security boundary is the sandbox
 * container.
 */
export async function spawnWarmHarness(
  opts: { harnessPath: string } & SpawnIdentity,
): Promise<WarmHarness> {
  switch (resolveSandboxBackend(process.env)) {
    case "subprocess":
      return spawnSubprocessWarm(opts);
    default:
      return spawnModalWarm(opts);
  }
}

// ── Current harness image tag ────────────────────────────────────────────────

const currentTagMemo = keyedMemoAsync<string | null>();

/**
 * The content-addressed harness image tag THIS process would spawn new
 * sandboxes from — what a deploy records on the agents row
 * (`harness_image_tag`), and what the pool's sandboxes were built from.
 * Null outside the Modal backend (the subprocess backend has no image and
 * pins nothing). Pure computation — base tag from env, harness code from
 * disk, toolchain specs from package.json — so it needs no Modal
 * credentials and never dials out.
 */
export function currentHarnessImageTag(harnessPath: string): Promise<string | null> {
  return currentTagMemo(harnessPath, async () => {
    if (resolveSandboxBackend(process.env) !== "modal") return null;
    const code = await readFile(harnessPath, "utf-8");
    const baseTag = process.env.MODAL_SANDBOX_IMAGE ?? DEFAULT_SANDBOX_IMAGE;
    return harnessImageTag(baseTag, code, resolveToolchainSpecs());
  });
}

/**
 * Best-effort re-tag of a POOLED sandbox with the role/slug it was acquired
 * for. Fire-and-forget: tags are observability only, and a failed retag
 * (sandbox racing its own death, transient control-plane error) must never
 * fail the session that acquired the harness.
 */
function retagWarm(warm: WarmHarness, identity: SpawnIdentity): void {
  void warm
    .setTags?.(sandboxTags(resolveSandboxRole(identity), identity.slug))
    .catch(() => undefined);
}

// ── Warm-harness acquisition ─────────────────────────────────────────────────

/**
 * Get a warm harness: a pooled one when the caller holds a pool, else a cold
 * spawn. `acquire()` returns null when the pool is empty or its harnesses are
 * dead.
 *
 * Every guest consumer needs this and each used to write it out, so the
 * `harnessPath ?? resolveHarnessPath()` default was restated per site and the
 * naive form was what a new consumer got by default. Note this covers only
 * *acquisition* — the pooled-harness-died-before-first-use retry stays in
 * `createSandboxVm`, because recovering from it means redoing that caller's
 * whole configure step, which differs per consumer.
 */
export function acquireWarmHarness(
  opts: {
    pool?: { acquire(): Promise<WarmHarness | null> } | undefined;
    harnessPath?: string | undefined;
    slug: string;
    role?: SandboxRole | undefined;
  },
  spawn: typeof spawnWarmHarness = spawnWarmHarness,
): Promise<WarmHarness> {
  const harnessPath = opts.harnessPath ?? resolveHarnessPath();
  return Promise.resolve(opts.pool?.acquire() ?? null).then((pooled) => {
    if (pooled) {
      // Pooled sandboxes were tagged "pool" at creation; stamp their real
      // identity now so the Modal dashboard shows what they became.
      retagWarm(pooled, opts);
      return pooled;
    }
    return spawn({ harnessPath, slug: opts.slug, role: opts.role });
  });
}

// ── Bundle inspection ────────────────────────────────────────────────────────

/**
 * Load a worker bundle in a throwaway sandbox and return the agent config the
 * bundle extracted about itself (its `__aaiConfig` export — see the guest
 * harness). The bundle is *evaluated in the sandbox*, never on the host, so
 * this is safe to run on untrusted studio-authored code. The sandbox is torn
 * down before returning.
 *
 * Returns `undefined` when the bundle does not self-describe (e.g. a plain
 * CLI-built worker, which ships its config separately).
 */
export async function describeBundle(
  opts: { harnessPath: string; workerCode: string; pool?: SandboxPool | undefined },
  spawn: typeof spawnWarmHarness = spawnWarmHarness,
): Promise<unknown> {
  await using warm = await acquireWarmHarness(
    { pool: opts.pool, harnessPath: opts.harnessPath, slug: "studio-inspect", role: "inspect" },
    spawn,
  );
  // No handlers registered: a bundle whose top level issues a guest→host
  // request gets the transport's -32601 error reply instead of wedging the
  // load until the RPC timeout.
  warm.conn.listen();
  // The reply is guest-asserted wire data (see BundleLoadResult); the
  // caller validates `config` with IsolateConfigSchema.
  const result = (await warm.conn.sendRequest("bundle/load", {
    code: opts.workerCode,
    env: {},
  })) as BundleLoadResult | undefined;
  return result?.config;
}

// ── Agent-server spawning ─────────────────────────────────────────────────────

/** Injectable backend spawners (tests). */
type AgentSpawners = {
  modal: typeof spawnModalAgentServer;
  subprocess: typeof spawnSubprocessAgentServer;
};

/**
 * Spawn one DEPLOYED AGENT as a server on the selected backend. The single
 * dispatch point mirroring {@link spawnWarmHarness}, but for the HTTP-only
 * agent contract: boot artifacts (bundle, hash, env) are delivered at exec
 * time, readiness is the guest's `/health`, and the returned handle exposes
 * only the manage surface plus terminate.
 *
 * Agents never take the warm pool: pooled sandboxes are control-channel
 * harnesses on the CURRENT image, and the agent contract is boot-time
 * provisioning on the deploy's PINNED image — there is nothing a generic
 * pre-booted harness could contribute without reintroducing bundle/load.
 */
export async function spawnAgentServer(
  opts: AgentSpawnOptions,
  spawners: AgentSpawners = {
    modal: spawnModalAgentServer,
    subprocess: spawnSubprocessAgentServer,
  },
): Promise<AgentServerHandle> {
  // The blob store is content-addressed; carrying the hash to the guest
  // (which verifies before loading) extends that property end-to-end.
  const workerSha256 = createHash("sha256").update(opts.workerCode, "utf-8").digest("hex");
  const common = {
    harnessPath: opts.harnessPath,
    slug: opts.slug,
    workerCode: opts.workerCode,
    workerSha256,
    agentEnv: opts.env,
  };
  switch (resolveSandboxBackend(process.env)) {
    case "subprocess":
      return spawners.subprocess(common);
    default:
      return spawners.modal({ ...common, imageTag: opts.imageTag });
  }
}
