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
 * The control-channel machinery below ({@link spawnWarmHarness}) remains for
 * the STUDIO side — coding-agent sessions and Publish — which always runs
 * the CURRENT harness image and may change atomically with the server.
 * Deploy-time bundle inspection ({@link describeBundle}) is a one-shot
 * describe-mode exec, not a channel.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { keyedMemoAsync } from "./_memo.ts";
import { describeModalBundle } from "./modal-describe.ts";
import { harnessImageTag, resolveToolchainSpecs } from "./modal-harness-image.ts";
import { DEFAULT_SANDBOX_IMAGE, spawnModalAgentServer, spawnModalWarm } from "./modal-sandbox.ts";
import type { GuestConnection } from "./rpc-schemas.ts";
import { resolveSandboxBackend } from "./sandbox-backend.ts";
import type { SpawnIdentity } from "./sandbox-role.ts";
import {
  describeSubprocessBundle,
  spawnSubprocessAgentServer,
  spawnSubprocessWarm,
} from "./subprocess-sandbox.ts";
import type { AgentServerHandle } from "./warm-harness.ts";

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * A spawned control-channel harness (studio/inspect side) whose guest
 * process is running and whose RPC connection is dialed, but which has NOT
 * yet received its session install. `listen()` has not been
 * called on the connection yet — the consumer registers its handlers first.
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
  /** Register a one-shot listener for guest exit. */
  onExit: (cb: () => void) => void;
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
 * Single dispatch point for the backend policy. `resolveSandboxBackend` (see
 * `sandbox-backend.ts`) picks Modal in production and the isolation-free
 * `subprocess` backend in local dev. Spawning fails loudly when the chosen
 * backend's prerequisites are absent — there is no fallback *between* backends
 * at spawn time, only at selection time, and selection can never reach
 * `subprocess` outside local dev.
 *
 * `slug`/`role` only affect the sandbox's observability tags (see
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
 * (`harness_image_tag`).
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

// ── Bundle inspection ────────────────────────────────────────────────────────

/** Injectable backend describers (tests). */
type BundleDescribers = {
  modal: typeof describeModalBundle;
  subprocess: typeof describeSubprocessBundle;
};

/**
 * Load a worker bundle in a throwaway ONE-SHOT sandbox exec (the guest's
 * describe mode — see the harness's `mainDescribe`) and return the agent
 * config the bundle extracted about itself (its `__aaiConfig` export). The
 * bundle is *evaluated in the sandbox*, never on the host, so this is safe
 * to run on untrusted studio-authored code; there is no control channel, no
 * token, and no server — the process's last stdout line is the whole
 * protocol. The result is guest-asserted wire data; the caller validates
 * `config` with IsolateConfigSchema.
 *
 * Returns `undefined` when the bundle does not self-describe (e.g. a plain
 * CLI-built worker, which ships its config separately).
 */
export async function describeBundle(
  opts: { harnessPath: string; workerCode: string },
  describers: BundleDescribers = {
    modal: describeModalBundle,
    subprocess: describeSubprocessBundle,
  },
): Promise<unknown> {
  switch (resolveSandboxBackend(process.env)) {
    case "subprocess":
      return describers.subprocess(opts);
    default:
      return describers.modal(opts);
  }
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
 * Every spawn boots directly from the published harness snapshot image —
 * there is no warm pool (deleted; production always ran with it disabled).
 * When Modal's JS SDK exposes sandbox MEMORY snapshots, this single spawn
 * path is where restore-from-snapshot slots in.
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
