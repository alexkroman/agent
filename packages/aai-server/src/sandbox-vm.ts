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
 */

import { readFile } from "node:fs/promises";
import { keyedMemoAsync } from "./_memo.ts";
import { spawnMicrosandboxAgentServer } from "./microsandbox-agent-sandbox.ts";
import { rewriteLoopbackForGuest } from "./microsandbox-network.ts";
import { microsandboxHarnessImageTag, spawnMicrosandboxWarm } from "./microsandbox-sandbox.ts";
import { spawnModalAgentServer } from "./modal-agent-sandbox.ts";
import { sandboxBaseTag } from "./modal-context.ts";
import { localHarnessImageTag } from "./modal-harness-image.ts";
import { spawnModalWarm } from "./modal-sandbox.ts";
import type { GuestConnection } from "./rpc-schemas.ts";
import { resolveSandboxBackend, type SandboxBackend } from "./sandbox-backend.ts";
import { agentSandboxName } from "./sandbox-directory.ts";
import type { SpawnIdentity } from "./sandbox-role.ts";
import { spawnSubprocessAgentServer, spawnSubprocessWarm } from "./subprocess-sandbox.ts";
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
  /**
   * The per-sandbox bearer minted at spawn, gating this guest's `/ws`,
   * `/manage/*`, and `/studio/session-init`. Exposed so the studio broker can
   * hand it to a PEER replica through the session registry — the peer holds
   * no socket to this guest but must still be able to install a session over
   * HTTP (see aai-studio-server/studio-session-registry.ts). It is a platform
   * secret, never handed to a browser: the browser gets the `chatToken`.
   */
  token: string;
  cleanup: () => Promise<void>;
  /** True while the underlying guest process is alive. */
  alive: () => boolean;
  /** Register a one-shot listener for guest exit. */
  onExit: (cb: () => void) => void;
  [Symbol.asyncDispose](): Promise<void>;
};

/**
 * How the worker bundle reaches the guest — either the bytes themselves, or a
 * URL the guest fetches them from.
 *
 * `url` is the production path: the platform used to read ~8 MB out of Storage
 * and push the same bytes into the sandbox, so the bundle crossed this process
 * twice per cold spawn. A time-boxed signed Storage URL (see
 * `BlobStorage.signedUrl`) removes both hops. `inline` covers everything that
 * cannot sign — the memory blob store behind local dev and tests — and guests
 * pinned to a harness image that predates URL delivery (see
 * the harness image tag).
 *
 * `sha256` rides along in BOTH shapes and is the agents row's `worker_hash` —
 * the deploy's own record of what it published, not a digest of whatever
 * arrived. The guest refuses to load a bundle that does not match it, so the
 * delivery path is trusted in neither shape.
 */
export type WorkerSource =
  | { kind: "inline"; code: string; sha256: string }
  | { kind: "url"; url: string; sha256: string };

export type AgentSpawnOptions = {
  slug: string;
  /** Deploy version — half the fleet-wide sandbox name (sandbox-directory.ts). */
  version: number;
  worker: WorkerSource;
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
  /**
   * Published the moment the guest exists and BEFORE it is ready — see
   * {@link BackendAgentSpawn.onSpawned}, which carries the argument.
   */
  onSpawned?: ((terminate: () => Promise<void>) => void) | undefined;
};

// ── The backend contract ─────────────────────────────────────────────────────

/** What a backend's agent-server spawner is handed. */
export type BackendAgentSpawn = {
  harnessPath: string;
  slug: string;
  /** The bundle itself, or a URL the guest pulls it from. */
  worker: WorkerSource;
  agentEnv: Record<string, string>;
  /** Modal only — the harness snapshot image this deploy is pinned to. */
  imageTag?: string | undefined;
  /**
   * The fleet-wide sandbox name (see sandbox-directory.ts).
   *
   * REQUIRED, and no longer Modal-only: Modal races on it to keep one sandbox
   * per deploy, and BOTH backends derive the guest's manage token from it
   * (`guest-token.ts`), which is what lets a replica that did not spawn a
   * sandbox still read its logs. The dispatch below always computes one.
   */
  name: string;
  /**
   * Hand the caller a KILL for a guest that is not ready yet, as soon as one
   * exists — which is long before this spawner's promise settles.
   *
   * **A teardown must not depend on a boot succeeding.** `terminate` used to
   * be published only on the resolved {@link AgentServerHandle}, so
   * `Sandbox.shutdown()` had nothing to call while `vmReady` was pending: it
   * waited `SANDBOX_TEARDOWN_READY_MS` (5s) and then walked away, leaving the
   * guest to boot and self-exit. A ~17s Modal boot raced a project DELETE
   * exactly that way in production — the delete dropped the app's Postgres
   * role and database, the abandoned guest finished booting, and its Workflow
   * DevKit migration reported `28P01 password authentication failed for user
   * "app_<hex>"` against credentials that had been valid when its env was
   * composed. That reads as a storage-credential bug and is a lifecycle race.
   *
   * Called AT MOST ONCE, before readiness. Terminating through it is expected
   * to make the in-flight spawn fail, which is the point: the spawner's own
   * cleanup then runs and `vmReady` rejects, so `onSandboxLost` detaches the
   * slot the way it would for any failed boot.
   */
  onSpawned?: ((terminate: () => Promise<void>) => void) | undefined;
};

/**
 * The operations a sandbox backend implements. Both backends implement all
 * four; this type is what says so.
 *
 * It replaced four independent `switch (resolveSandboxBackend(...))`
 * statements, one per operation, each shaped
 * `case "subprocess": … default: → modal`. Two problems with that: the
 * `default` arm meant a third backend compiled clean and silently ran on
 * Modal at every one of the four sites, and nothing anywhere stated that the
 * two backends were answering the same set of questions — so an operation
 * added for one could be missed for the other. Indexing a
 * `Record<SandboxBackend, …>` is exhaustive by construction: a new member of
 * the union fails to compile until it has all four.
 */
export type SandboxBackendOps = {
  spawnWarm(opts: { harnessPath: string } & SpawnIdentity): Promise<WarmHarness>;
  spawnAgentServer(opts: BackendAgentSpawn): Promise<AgentServerHandle>;
  /**
   * The content-addressed harness image tag new sandboxes spawn from, or null
   * for a backend with no image (nothing to pin).
   */
  harnessImageTag(harnessPath: string): Promise<string | null>;
};

const SANDBOX_BACKENDS: Record<SandboxBackend, SandboxBackendOps> = {
  modal: {
    spawnWarm: spawnModalWarm,
    spawnAgentServer: spawnModalAgentServer,
    // Pure computation — base tag from env, harness code from disk, toolchain
    // specs from package.json — so it needs no Modal credentials and never
    // dials out.
    harnessImageTag: async (harnessPath) =>
      localHarnessImageTag(sandboxBaseTag(), await readFile(harnessPath, "utf-8")),
  },
  microsandbox: {
    spawnWarm: spawnMicrosandboxWarm,
    // The Modal-only `imageTag` is dropped here for the same reason the
    // subprocess entry drops it: a pinned MODAL image name means nothing to a
    // microVM. What this backend pins instead is its own image reference —
    // see microsandboxHarnessImageTag.
    spawnAgentServer: (opts) =>
      spawnMicrosandboxAgentServer({
        harnessPath: opts.harnessPath,
        slug: opts.slug,
        name: opts.name,
        worker: opts.worker,
        agentEnv: opts.agentEnv,
        onSpawned: opts.onSpawned,
      }),
    harnessImageTag: microsandboxHarnessImageTag,
  },
  subprocess: {
    spawnWarm: spawnSubprocessWarm,
    // The Modal-only fields are dropped HERE, explicitly, rather than left to
    // be ignored by the callee's signature: there is no image to pin.
    //
    // `name` is NOT one of them any more. It was, when its only job was Modal
    // uniqueness — a single process has no fleet to be unique within, nor a
    // control plane that would enforce a name. It is now also what the guest's
    // manage token is derived from (`guest-token.ts`), so dropping it here
    // would make this backend the one place a token is drawn at random, i.e.
    // the one place `aai dev` cannot reproduce production's behaviour.
    spawnAgentServer: (opts) =>
      spawnSubprocessAgentServer({
        harnessPath: opts.harnessPath,
        slug: opts.slug,
        name: opts.name,
        worker: opts.worker,
        agentEnv: opts.agentEnv,
        // NOT a Modal-only field: a mid-boot kill is the contract both
        // backends owe `Sandbox.shutdown()`, and dev is where the delete
        // path is exercised without a Modal control plane in the way.
        onSpawned: opts.onSpawned,
      }),
    harnessImageTag: async () => null,
  },
};

/**
 * The backend this process runs on. `resolveSandboxBackend` (see
 * `sandbox-backend.ts`) picks Modal in production and the isolation-free
 * `subprocess` backend in local dev. Operations fail loudly when the chosen
 * backend's prerequisites are absent — there is no fallback *between*
 * backends at call time, only at selection time, and selection can never
 * reach `subprocess` outside local dev.
 *
 * `backends` is the test seam: a full per-backend record, so an injected fake
 * resolves through the same selection policy as the real thing.
 */
function activeBackend(
  backends: Record<SandboxBackend, SandboxBackendOps> = SANDBOX_BACKENDS,
): SandboxBackendOps {
  return backends[resolveSandboxBackend(process.env)];
}

/** Per-backend implementations of ONE operation — the narrow test seam. */
export type BackendMap<Op extends keyof SandboxBackendOps> = Record<
  SandboxBackend,
  SandboxBackendOps[Op]
>;

function opFor<Op extends keyof SandboxBackendOps>(
  op: Op,
  override: BackendMap<Op> | undefined,
): SandboxBackendOps[Op] {
  return override ? override[resolveSandboxBackend(process.env)] : activeBackend()[op];
}

/**
 * A URL the platform hands a guest, made reachable FROM that guest.
 *
 * Every backend but one is identity: a Modal guest reaches the platform's
 * public origin over the internet, and a subprocess guest shares the host's
 * network stack. A microVM has neither — its `127.0.0.1` is itself — so a
 * loopback origin has to become the host alias.
 *
 * This exists as ONE function because the rule has now been applied ad hoc
 * three times: the agent's env (`rewriteLoopbackForGuest`), the worker bundle's
 * signed URL, and the platform origin an in-guest `aai deploy` is given. The
 * third was a 404 the guest returned to itself. Anything else that hands a URL
 * across this boundary goes through here.
 */
export function guestReachableUrl(url: string, env: NodeJS.ProcessEnv = process.env): string {
  if (resolveSandboxBackend(env) !== "microsandbox") return url;
  return rewriteLoopbackForGuest({ url }).env.url ?? url;
}

// ── Warm-harness spawning ────────────────────────────────────────────────────

/**
 * Spawn a warm Node harness in a fresh sandbox. The returned WarmHarness has
 * a running guest process and a dialed RPC channel, but no listeners
 * attached and no bundle loaded.
 *
 * `slug`/`role` only affect the sandbox's observability tags (see
 * sandbox-role.ts); under Modal the security boundary is the sandbox
 * container.
 */
export async function spawnWarmHarness(
  opts: { harnessPath: string } & SpawnIdentity,
): Promise<WarmHarness> {
  return activeBackend().spawnWarm(opts);
}

// ── Current harness image tag ────────────────────────────────────────────────

const currentTagMemo = keyedMemoAsync<string | null>();

/**
 * The content-addressed harness image tag THIS process would spawn new
 * sandboxes from — what a deploy records on the agents row
 * (`harness_image_tag`). Null outside the Modal backend (the subprocess
 * backend has no image and pins nothing).
 */
export function currentHarnessImageTag(harnessPath: string): Promise<string | null> {
  return currentTagMemo(harnessPath, () => activeBackend().harnessImageTag(harnessPath));
}

// ── Agent-server spawning ─────────────────────────────────────────────────────

/**
 * Spawn one DEPLOYED AGENT as a server on the selected backend. Mirrors
 * {@link spawnWarmHarness}, but for the HTTP-only agent contract: boot
 * artifacts (bundle, hash, env) are delivered at exec time, readiness is the
 * guest's `/health`, and the returned handle exposes only the manage surface
 * plus terminate.
 *
 * Every spawn boots directly from the published harness snapshot image —
 * there is no warm pool (deleted; production always ran with it disabled).
 * When Modal's JS SDK exposes sandbox MEMORY snapshots, this single spawn
 * path is where restore-from-snapshot slots in.
 */
export async function spawnAgentServer(
  opts: AgentSpawnOptions,
  spawners?: BackendMap<"spawnAgentServer">,
): Promise<AgentServerHandle> {
  return opFor(
    "spawnAgentServer",
    spawners,
  )({
    harnessPath: opts.harnessPath,
    slug: opts.slug,
    // The blob store is content-addressed and the hash rides on the source
    // (see WorkerSource); the guest verifies before loading, which extends
    // that property end-to-end whichever way the bytes travelled.
    worker: opts.worker,
    agentEnv: opts.env,
    imageTag: opts.imageTag,
    name: agentSandboxName(opts.slug, opts.version),
    onSpawned: opts.onSpawned,
  });
}
