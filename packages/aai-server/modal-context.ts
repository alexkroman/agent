// Copyright 2026 the AAI authors. MIT license.
/**
 * The shared Modal context — everything every spawn path needs BEFORE it can
 * ask Modal for a sandbox: the client, the App, the snapshot image the guest
 * boots from, and the harness bytes that image is keyed on.
 *
 * Split from modal-sandbox.ts (which owns the control-channel spawn) for the
 * same reason modal-agent-sandbox.ts, modal-describe.ts and
 * modal-sandbox-directory.ts were: those three, plus the spawner, share
 * nothing with each other EXCEPT this. Keeping it here is what makes
 * "resolved once per process, memoized, joined by whoever races it" a
 * property of one module rather than a comment repeated at four call sites.
 *
 * Credentials: `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET` (or a `~/.modal.toml`
 * profile — the SDK resolves both). There is no fallback backend: without
 * Modal credentials, sandbox creation fails loudly in dev and prod alike.
 */

import { readFile } from "node:fs/promises";
import { errorMessage } from "@alexkroman1/aai";
import { omitUndefined } from "@alexkroman1/aai/utils";
import {
  AlreadyExistsError,
  type Image,
  ModalClient,
  Probe,
  type SandboxCreateParams,
} from "modal";
import { keyedMemoAsync, memoAsync } from "./_memo.ts";
import { createGuestImageSource, snapshotImageSource } from "./guest-image-source.ts";
import { createLogger } from "./logger.ts";
import {
  DEFAULT_SANDBOX_IDLE_TIMEOUT_MS,
  DEFAULT_SANDBOX_TIMEOUT_MS,
  guestSandboxResources,
} from "./modal-sandbox-env.ts";
import { SandboxNameTakenError } from "./sandbox-directory.ts";
import { SandboxUnavailableError } from "./sandbox-errors.ts";
import { type SandboxRole, sandboxTags } from "./sandbox-role.ts";

const log = createLogger("modal");

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
 * at `HARNESS_REMOTE_PATH`, served from a baked snapshot image (built
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

/**
 * The base image tag a guest sandbox is built on — {@link DEFAULT_SANDBOX_IMAGE}
 * unless `MODAL_SANDBOX_IMAGE` overrides it. One reader rather than a
 * `process.env.MODAL_SANDBOX_IMAGE ?? DEFAULT_SANDBOX_IMAGE` per call site:
 * the tag is an INPUT to the harness image hash (`localHarnessImageTag`), so a
 * site that read the env differently would key the snapshot on a different
 * image than the one the spawn actually uses.
 */
export function sandboxBaseTag(): string {
  return process.env.MODAL_SANDBOX_IMAGE ?? DEFAULT_SANDBOX_IMAGE;
}

/** Modal App the sandboxes are created under. Override with `MODAL_APP_NAME`. */
const DEFAULT_MODAL_APP_NAME = "aai-server";

/** Container port the harness WebSocket server listens on (tunneled). */
export const GUEST_PORT = 8080;

/**
 * The guest's one origin, from the sandbox's tunnel map.
 *
 * Every guest surface derives from this — the bearer-gated control channel, the
 * public auth-free client-session endpoint, the studio chat (see
 * `GUEST_ROUTES`) — so both spawners need exactly the same three steps: look up
 * the tunnel for the harness's port, fail loudly if Modal returned none, and
 * build the `wss://` origin. It lives beside {@link GUEST_PORT} because that
 * port is the only thing the lookup keys on.
 *
 * This is deliberately the ONLY thing the two spawn paths share after
 * `createGuestSandbox`. What surrounds it differs on purpose — the agent path
 * writes boot artifacts before its exec and pre-issues `sb.tunnels()` so the
 * round trip overlaps that write — and those differences are load-bearing, not
 * drift (see "An agent spawn's steps are ordered by what they actually depend
 * on" in CLAUDE.md). Merging the surrounding `Promise.all`s would re-serialize
 * exactly what the tests there pin.
 */
export function guestOrigin(tunnels: Record<number, { host: string; port: number }>): string {
  const tunnel = tunnels[GUEST_PORT];
  if (!tunnel) {
    throw new Error(`no tunnel for guest port ${GUEST_PORT}`);
  }
  return `wss://${tunnel.host}:${tunnel.port}`;
}

/** Probe evaluation interval — half of it is dead spawn time; see CLAUDE.md. */
const READINESS_PROBE_INTERVAL_MS = 100;

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

/**
 * The `SandboxCreateParams` every guest spawn shares — the tunnelled port, the
 * readiness probe, the env-derived limits and resources, and the observability
 * tags.
 *
 * The two spawners (control-channel in `modal-sandbox.ts`, deployed agent in
 * `modal-agent-sandbox.ts`) differ in everything AFTER creation and in nothing
 * about the container they create, so this is the shape of a guest sandbox
 * stated once. A `name` claims the fleet-wide identity Modal enforces (see
 * sandbox-directory.ts); omit it for an unnamed spawn.
 *
 * NOTE the caller must pass `name` as a plain value, never reach into its own
 * `opts` inside a closure over the result — see the allocation note in
 * `spawnModalAgentServer`.
 */
export function guestSandboxCreateParams(opts: {
  role: SandboxRole;
  slug?: string | undefined;
  name?: string | undefined;
}): SandboxCreateParams {
  const { limits, resourceParams } = guestSandboxResources(process.env);
  return {
    // Explicit idle entrypoint: the exec'd harness is what holds the sandbox
    // active, so its exit is what starts the idle timer.
    command: ["sleep", "infinity"],
    // The host (or a client) reaches the guest through this tunnel; the
    // harness's bearer-token check is what keeps the public tunnel URL from
    // being an open door.
    encryptedPorts: [GUEST_PORT],
    readinessProbe: GUEST_READINESS_PROBE,
    timeoutMs: limits.timeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS,
    idleTimeoutMs: limits.idleTimeoutMs ?? DEFAULT_SANDBOX_IDLE_TIMEOUT_MS,
    ...resourceParams,
    tags: sandboxTags(opts.role, opts.slug),
    ...omitUndefined({ name: opts.name }),
  };
}

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
 * Turn any spawn-path failure into the taxonomy this platform answers with.
 *
 * Every spawn failure is a {@link SandboxUnavailableError} — a marker class, not
 * a message: `createErrorHandler` turns it into a **retryable 503** carrying one
 * authored sentence, and logs the technical message at `warn` with the whole
 * `cause` chain. Keeping the two apart is what lets the log stay specific while
 * the wire body leaks nothing.
 *
 * ## What escaped, and what it cost
 *
 * Both spawners wrap their own bodies that way, and NEITHER could wrap the image
 * resolution or the create: their `catch` calls `sb.terminate()`, so those two
 * steps have to sit outside it — and a failure there escaped untranslated. On
 * 2026-08-31 an unpublished registry image reached the studio session route as a
 * bare `Error`: `http unhandled error`, `500 Internal server error`. The studio
 * client retries 5xx and then shows that sentence, so the one distinction a user
 * needs — "try again in a minute" versus "this project is broken" — was exactly
 * the one destroyed. It is the same gap the studio path had before it was given
 * the agent path's taxonomy; it had survived one layer down.
 *
 * ## `SandboxNameTakenError` passes THROUGH
 *
 * It is a routing signal `awaitBrokeredUrl` catches to return to the sandbox
 * directory — never an answer to a client. Wrapping it would turn the peer route
 * into a 503 and reintroduce the duplicate-sandbox spawn the name exists to
 * prevent.
 *
 * Returns the error to throw rather than throwing, so the call site reads as a
 * plain rethrow — same shape as {@link translateCreateError} above.
 */
export function translateSpawnFailure(err: unknown): unknown {
  if (err instanceof SandboxNameTakenError) return err;
  if (err instanceof SandboxUnavailableError) return err;
  return new SandboxUnavailableError(`Modal guest sandbox create failed: ${errorMessage(err)}`, {
    cause: err,
  });
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
    log.warn("SANDBOX_IGNORE_IMAGE_PINS=1: ignoring pinned harness image", { imageTag });
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
  const baseTag = sandboxBaseTag();
  const baseImage = client.images.fromRegistry(baseTag);

  // Registry pull, or the legacy in-process snapshot build — see
  // guest-image-source.ts for the policy. Logged because `fromRegistry` is
  // lazy: an image that was never published fails at CREATE, and "which image
  // am I pulling, and from where" must be answerable from one line rather than
  // inferred from the shape of that later error.
  const images = createGuestImageSource({
    client,
    baseTag,
    snapshot: () => snapshotImageSource({ client, app, baseTag, baseImage }),
  });
  log.info("Guest image source", { kind: images.kind, reason: images.reason, baseTag });

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
      // Image resolution and create are the two steps NEITHER spawner can wrap:
      // their `catch` calls `sb.terminate()`, so the create has to sit outside
      // it. See translateSpawnFailure for what escaped and what it cost.
      try {
        const image = await resolveSpawnImage({
          imageTag,
          fromName: images.byTag,
          current: () => images.current(code),
        });
        return await create(image, params);
      } catch (err) {
        throw translateSpawnFailure(err);
      }
    },
    async prepareGuestImage(code) {
      await images.prepare(code);
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
    log.debug("Guest harness image ready", { ms: Date.now() - started });
  })().catch((err: unknown) => {
    log.warn("prewarm failed", { error: errorMessage(err) });
  });
}

// ── Harness code cache ───────────────────────────────────────────────────────

const harnessCache = keyedMemoAsync<string>();

/** Read (and memoize) the built guest harness — it is stable per process. */
export function harnessCode(harnessPath: string): Promise<string> {
  return harnessCache(harnessPath, () => readFile(harnessPath, "utf-8"));
}

/**
 * @internal Drop every memo this module holds — the client, the resolved
 * context, and the harness bytes. Exposed for unit tests only.
 */
export function resetModalContext(): void {
  modalContext.reset();
  clientMemo = null;
  harnessCache.clear();
}
