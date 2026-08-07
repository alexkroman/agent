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

import { readFile } from "node:fs/promises";
import { keyedMemoAsync } from "./_memo.ts";
import { spawnModalAgentServer } from "./modal-agent-sandbox.ts";
import { DEFAULT_SANDBOX_IMAGE } from "./modal-context.ts";
import { describeModalBundle } from "./modal-describe.ts";
import { localHarnessImageTag } from "./modal-harness-image.ts";
import { spawnModalWarm } from "./modal-sandbox.ts";
import type { GuestConnection } from "./rpc-schemas.ts";
import { resolveSandboxBackend, type SandboxBackend } from "./sandbox-backend.ts";
import { agentSandboxName } from "./sandbox-directory.ts";
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
 * {@link guestUnderstandsBundleUrl}).
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
  /** Modal only — the fleet-wide sandbox name (see sandbox-directory.ts). */
  name?: string | undefined;
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
  describeBundle(opts: { harnessPath: string; workerCode: string }): Promise<unknown>;
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
    describeBundle: describeModalBundle,
    // Pure computation — base tag from env, harness code from disk, toolchain
    // specs from package.json — so it needs no Modal credentials and never
    // dials out.
    harnessImageTag: async (harnessPath) =>
      localHarnessImageTag(
        process.env.MODAL_SANDBOX_IMAGE ?? DEFAULT_SANDBOX_IMAGE,
        await readFile(harnessPath, "utf-8"),
      ),
  },
  subprocess: {
    spawnWarm: spawnSubprocessWarm,
    // The Modal-only fields are dropped HERE, explicitly, rather than left to
    // be ignored by the callee's signature: there is no image to pin, and a
    // single process has no fleet to be unique within (nor a Modal control
    // plane that would enforce a name).
    spawnAgentServer: (opts) =>
      spawnSubprocessAgentServer({
        harnessPath: opts.harnessPath,
        slug: opts.slug,
        worker: opts.worker,
        agentEnv: opts.agentEnv,
      }),
    describeBundle: describeSubprocessBundle,
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

/**
 * Whether a spawn pinned to `imageTag` will run the harness THIS process
 * built — the only harness known to understand a `url` {@link WorkerSource}.
 *
 * Deployed agents spawn from the image recorded on their row at deploy time,
 * so the guest can be arbitrarily older than the platform. URL delivery is an
 * ADDITIVE boot-env change (`AAI_BUNDLE_URL` beside `AAI_BUNDLE_PATH`), and an
 * older harness reads neither — it fails boot with "agent mode requires
 * AAI_BUNDLE_PATH". Handing every pinned guest a URL would therefore have
 * broken every already-deployed agent on the next platform deploy, so the
 * caller asks first and falls back to shipping the bytes.
 *
 * The three ways the answer is yes: no pin at all (the current image), the
 * operator forced pins aside (`SANDBOX_IGNORE_IMAGE_PINS`, which
 * `resolveSpawnImage` honours by substituting the current image — this must
 * agree with it), and a pin that IS the current tag. The tag hashes the
 * harness bundle's content, so "same tag" means "same harness", exactly the
 * question being asked.
 */
export async function guestUnderstandsBundleUrl(
  harnessPath: string,
  imageTag: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (!imageTag) return true;
  if (env.SANDBOX_IGNORE_IMAGE_PINS === "1") return true;
  return imageTag === (await currentHarnessImageTag(harnessPath));
}

// ── Bundle inspection ────────────────────────────────────────────────────────

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
  describers?: BackendMap<"describeBundle">,
): Promise<unknown> {
  return opFor("describeBundle", describers)(opts);
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
  });
}
