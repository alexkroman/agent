// Copyright 2026 the AAI authors. MIT license.
/**
 * microVM-backed sandbox spawning — the ISOLATED developer backend.
 *
 * The guest harness runs inside a microsandbox microVM (libkrun on
 * Hypervisor.framework or KVM) booted from the SAME OCI image production pulls,
 * with a published loopback port for the host to dial. Selected in local dev;
 * see `sandbox-backend.ts` for the policy.
 *
 * ## What this gives you that `subprocess` cannot
 *
 * - **A real boundary.** The studio coding agent's `bash` and `run_code` execute
 *   IN THE GUEST (`aai-guest/studio-tools.ts`, `aai-guest/trial.ts`), so under
 *   `subprocess` an LLM-authored shell line runs on the developer's machine with
 *   the server's uid. Here it runs in a VM with its own kernel.
 * - **Enforced limits.** `SANDBOX_MEMORY_LIMIT_MB` becomes real guest memory
 *   rather than V8's `--max-old-space-size` (a JS-heap bound only), and
 *   `SANDBOX_CPU_LIMIT` has an analog at last.
 * - **Production's toolchain.** Guests BUILD workspaces (`aai-guest/
 *   studio-build.ts` runs the CLI's own bundlers), and `subprocess` resolves
 *   that toolchain from aai-guest's own darwin/pnpm `node_modules` while
 *   production resolves `/opt/aai`, an `npm ci` tree on `node:26-slim`. A build
 *   failure caused by the toolchain tree is unreproducible locally under
 *   `subprocess`, by construction.
 *
 * ## What it still does not give you
 *
 * Production confidence — only `SANDBOX_BACKEND=modal` can, because that IS
 * production. The image reference is shared, the image BYTES are not: Modal runs
 * `linux/amd64` and an Apple Silicon host runs `linux/arm64`, so this is the
 * same recipe on a different architecture. Nor is the fleet real: one process,
 * no peers, no cross-replica locks.
 *
 * ## Deliberate parity choices
 *
 * `AAI_GUEST_HOST` is NOT set, so the harness binds `0.0.0.0` exactly as it does
 * under Modal — the override `subprocess` needs (its "guest" shares the dev
 * machine's interfaces) is a workaround for having no namespace, not a
 * convention. The guest reaches no further than its published port either way.
 *
 * `CONTAINED_ENV` IS set, via `guestExecBaseEnv()`: a real VM surrounds this
 * guest, so the SDK's network builtins drop their SSRF screen. That screen
 * guards nothing a tenant cannot bypass from their own tool code, and there are
 * no platform credentials in here to protect.
 *
 * The guest gets a MINIMAL env, never `process.env` — the rule
 * `subprocess-sandbox.ts` argues at length, and for the same reason: agent code
 * that wrongly reads `process.env` must fail here the way it fails in
 * production. What it does get is rewritten for the VM's network namespace; see
 * `microsandbox-network.ts`, which is the difference between `ctx.db` working
 * and silently pointing at the VM's own loopback.
 */

import { access } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { errorMessage } from "@alexkroman1/aai";
import { platformOwnPort } from "./_boot.ts";
import { guestImageRef, guestImageRegistry } from "./guest-image-source.ts";
import { GUEST_ROUTES, guestWsUrl } from "./guest-routes.ts";
import { guestTokenFor } from "./guest-token.ts";
import { createLogger } from "./logger.ts";
import { _contextInternals, defaultMicrosandboxContext } from "./microsandbox-context.ts";
import { GUEST_PORT, harnessCode, sandboxBaseTag } from "./modal-context.ts";
import {
  guestExecBaseEnv,
  HARNESS_REMOTE_PATH,
  localHarnessImageTag,
} from "./modal-harness-image.ts";
import { parseSandboxLimitsFromEnv } from "./modal-sandbox-env.ts";
import { SandboxUnavailableError } from "./sandbox-errors.ts";
import { resolveSandboxRole, type SpawnIdentity } from "./sandbox-role.ts";
import type { WarmHarness } from "./sandbox-vm.ts";
import {
  type DialGuest,
  dialGuest,
  type GuestProcLike,
  getFreePort,
  startGuestLogging,
  warmFromGuest,
} from "./warm-harness.ts";

const log = createLogger("sandbox.microsandbox");

/**
 * The image a microsandbox guest boots from when no registry is configured —
 * what `pnpm build:guest-image` writes locally.
 */
export const LOCAL_GUEST_IMAGE_TAG = "aai-guest-harness:local";

/**
 * Guest resources when the env declares none.
 *
 * **A microVM's memory is what you boot it with, and `maxMemory` is not burst.**
 * Measured: a guest at `memory(1024).maxMemory(4096)` is OOM-killed allocating
 * 1.8 GB, while `memory(4096)` allocates it fine. The guest kernel does expose
 * `/sys/devices/system/memory` with `auto_online_blocks`, so hotplug exists —
 * but nothing drives it under pressure, so the ceiling buys nothing at runtime.
 * Modal's reserve-the-idle-shape / cap-the-build-shape model (1 core + 1024 MiB
 * reserved, 4 / 4096 capped — `modal_deploy.py`) therefore does NOT translate:
 * there the cap is elastic headroom, here it would be a hard wall at the
 * reservation.
 *
 * So the number has to cover the PEAK, and the peak is MEASURED: building the
 * `link-digest` template in a guest (typecheck, then both bundles, as
 * `studio-build.ts` runs them) peaks at **1219 MB**, and it is the WORKER
 * bundle that gets there — 106 MB after the typecheck, ~1200 MB after
 * `buildWorker`. That corroborates the 1.29 GB wedge `aai-server/CLAUDE.md`
 * records, and it means 480 MiB was never survivable.
 *
 * 4096 is therefore ~3.4x a SMALL project's peak, kept because a real workspace
 * is bigger than a five-file template and a guest may serve a voice session
 * beside the build — which is the same reason production put its cap there
 * ("clear the bundler's peak with headroom for a co-resident session"). Lower
 * it against a measurement of a REAL project, not this one; erring low is what
 * sent us here.
 *
 * Without these, microsandbox's own defaults apply: **480 MiB and one core**
 * (measured — `MemTotal: 491608 kB`, `nproc: 1`). A workspace build there is
 * exactly that wedge — RSS pinned flat, one core split across GC and bundler
 * workers, no I/O and no progress — and the whole point of the account is that
 * **it reads as a hung build, never as an OOM**. Which is how it presented: the
 * harness logs `listening on 0.0.0.0:8080`, the studio's test-agent tool hangs,
 * and nothing further reaches the log.
 *
 * `subprocess` cannot see any of this. There `SANDBOX_MEMORY_LIMIT_MB` becomes
 * V8's `--max-old-space-size` — a JS-heap bound on a process with the whole
 * machine's RAM behind it — so an unset limit costs nothing. Here an unset
 * limit is a 480 MiB computer.
 */
export const DEFAULT_GUEST_MEMORY_MIB = 4096;
export const DEFAULT_GUEST_CPUS = 4;

/**
 * Rolldown's thread pool, pinned to one.
 *
 * The in-guest build's peak is NATIVE memory, not V8's — which is why
 * `--max-old-space-size` cannot bound it (`aai-server/CLAUDE.md`) — and each
 * Rolldown worker carries its own arena. The names come out of the binding
 * itself (`strings` on `rolldown-binding.*.node`): `ROLLDOWN_WORKER_THREADS`
 * and `ROLLDOWN_MAX_BLOCKING_THREADS` are Rolldown's own, `RAYON_NUM_THREADS`
 * the rayon pool underneath. Nothing in our bundler wrappers exposes a thread
 * count, so the env is the seam.
 *
 * `studio-build.ts` already serializes the two Rolldown passes for exactly this
 * reason ("two concurrent Rolldown passes peak at roughly the SUM of their
 * native allocations"); this is the same argument one level down, inside a
 * single pass.
 *
 * MICROSANDBOX ONLY, deliberately. A Modal guest reserves one core but may
 * burst to four (`modal_deploy.py`), so pinning there would trade production
 * build latency for memory it is allowed to use. A dev guest is trading the
 * other way: the memory it saves is what lets the VM be sized smaller.
 */
const GUEST_BUILD_ENV: Record<string, string> = {
  ROLLDOWN_WORKER_THREADS: "1",
  ROLLDOWN_MAX_BLOCKING_THREADS: "1",
  RAYON_NUM_THREADS: "1",
};

/** The build-thread pins, for the agent spawner in its own module. */
export function guestBuildEnv(): Record<string, string> {
  return { ...GUEST_BUILD_ENV };
}

/**
 * The host port the PLATFORM itself listens on.
 *
 * A studio guest has to reach it: the in-guest `aai deploy` that Publish and the
 * auto-preview deployer run is handed the platform's own origin, and a deploy is
 * a `POST /deploy` back to this server. Under `subprocess` that came free — the
 * guest shared the host's stack — and in a VM `localhost:8080` is the guest's
 * OWN harness, which serves no `/deploy`. The symptom is a 404 the guest returns
 * to itself:
 *
 *     guest stderr: POST /deploy 404
 *     Studio preview deploy failed { output: 'deploy failed (HTTP 404): Not found' }
 *
 * Which is exactly what the retired local-container backend was retired over —
 * "a loopback platform origin resolves to the guest's own harness rather than
 * the dev server, so Publish 404s against itself". Opening the port is half the
 * answer; the other half is rewriting the origin the guest is TOLD to use, which
 * is `guestReachableUrl` in sandbox-vm.ts.
 *
 * The parse itself is `platformOwnPort` now, shared with `agentPlatformBaseUrl`:
 * one of them opened this port and the other builds the URL a guest dials on it,
 * and they used to disagree on a mis-injected `PORT` — this one fell back to
 * `DEFAULT_PORT` where the entry point threw, so the policy opened 8080 for
 * a server that never bound it. This wrapper stays because the NAME is the
 * argument at this call site: the port being opened is the platform's, not the
 * guest's.
 */
function platformHostPort(env: NodeJS.ProcessEnv = process.env): number {
  return platformOwnPort(env);
}

// ── Structural sandbox types (injectable — unit tests boot no microVM) ───────

export type MicrosandboxProcLike = GuestProcLike & {
  /** Terminate the exec'd process. Fire-and-forget, like the sibling backends. */
  kill(): void;
};

export type MicrosandboxCreateParams = {
  /** OCI reference to boot from. */
  imageRef: string;
  /** Sandbox name — the fleet identity, and what the manage token derives from. */
  name: string;
  /** Host port published to the guest's {@link GUEST_PORT}. */
  hostPort: number;
  /** The guest's whole environment (already rewritten for the VM). */
  env: Record<string, string>;
  /** Host ports the guest may reach, derived from the env rewrite. */
  hostPorts: readonly number[];
  memoryLimitMiB?: number | undefined;
  cpus?: number | undefined;
  /** Observability labels — the analog of Modal's sandbox tags. */
  labels: Record<string, string>;
};

/** A booted microVM, reduced to what spawning needs. */
export type MicrosandboxHandle = {
  /** Start a long-lived process and stream its stdio. */
  exec(command: string[]): Promise<MicrosandboxProcLike>;
  /** Write a boot artifact into the guest before its exec. */
  writeFile(path: string, data: string): Promise<void>;
  /** Stop the whole VM. */
  stop(): Promise<void>;
};

export type MicrosandboxSpawnContext = {
  createSandbox(params: MicrosandboxCreateParams): Promise<MicrosandboxHandle>;
};

// ── Image reference ──────────────────────────────────────────────────────────

/**
 * Which image a guest boots from: the published, content-addressed one when a
 * registry is configured, else the local build.
 *
 * The registry case reuses `guestImageRef` and `localHarnessImageTag` rather
 * than composing a reference of its own, so a dev pointed at a registry pulls
 * the byte-identical image a deploy would — which is the entire point of the
 * OCI recipe.
 */
export function microsandboxImageRef(
  harnessCode: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const registry = guestImageRegistry(env);
  return registry === undefined
    ? LOCAL_GUEST_IMAGE_TAG
    : guestImageRef(registry, localHarnessImageTag(sandboxBaseTag(), harnessCode));
}

/**
 * The image reference a deploy PINS when it spawns on this backend, or null.
 *
 * Null for the local image: `aai-guest-harness:local` is a mutable tag that
 * `pnpm build:guest-image` overwrites, so recording it would promise an
 * environment nothing can reproduce. With a registry configured the reference
 * is content-addressed and pinning means what it means on Modal — which is why
 * this backend can honour a pin at all, where `subprocess` never could.
 */
export async function microsandboxHarnessImageTag(harnessPath: string): Promise<string | null> {
  if (guestImageRegistry(process.env) === undefined) return null;
  return localHarnessImageTag(sandboxBaseTag(), await harnessCode(harnessPath));
}

export { defaultMicrosandboxContext } from "./microsandbox-context.ts";

// ── Warm (control-channel) spawning ──────────────────────────────────────────

/**
 * Spawn a warm harness in a microVM and dial its control channel. Mirrors
 * `spawnModalWarm`: a running harness and a connected RPC channel, with no
 * listeners attached and no bundle loaded.
 */
export async function spawnMicrosandboxWarm(
  opts: { harnessPath: string } & SpawnIdentity,
  ctx: MicrosandboxSpawnContext = defaultMicrosandboxContext(),
  dial: DialGuest = dialGuest,
): Promise<WarmHarness> {
  const slug = opts.slug ?? "(none)";
  const role = resolveSandboxRole(opts);
  const t0 = performance.now();
  try {
    // Checked up front so a missing build fails with the path, not as a dial
    // timeout against a VM whose harness was never there.
    await access(opts.harnessPath);
    const hostPort = await getFreePort();
    const limits = parseSandboxLimitsFromEnv(process.env);
    const name = opts.name ?? `aai-warm-${hostPort}`;
    const token = guestTokenFor(name);

    const sandbox = await ctx.createSandbox({
      imageRef: microsandboxImageRef(await harnessCode(opts.harnessPath)),
      name,
      hostPort,
      // A studio guest carries no tenant DSNs, so there is nothing to rewrite
      // and no host port to open.
      env: {
        // `TMPDIR` is in here, and this is the backend that needs it most: `/tmp`
        // in this VM is a 512 MiB RAM DISK, and a studio guest is where the
        // in-guest build runs. See `guestExecBaseEnv`.
        ...guestExecBaseEnv(),
        ...GUEST_BUILD_ENV,
        AAI_GUEST_TOKEN: token,
        AAI_GUEST_PORT: String(GUEST_PORT),
      },
      // A studio guest carries no tenant DSNs — but it DOES deploy, and a
      // deploy is a POST back to this platform. See platformHostPort.
      hostPorts: [platformHostPort()],
      memoryLimitMiB: limits.memoryLimitMiB ?? DEFAULT_GUEST_MEMORY_MIB,
      cpus: limits.cpuLimit ?? DEFAULT_GUEST_CPUS,
      labels: { role, slug },
    });

    const terminate = async (): Promise<void> => {
      await sandbox.stop().catch(() => undefined);
    };

    try {
      const proc = await sandbox.exec(["node", HARNESS_REMOTE_PATH]);
      // Before the dial: a harness that dies during boot must still get its
      // stderr into the host log.
      startGuestLogging(proc, `microsandbox:${hostPort}`);
      const origin = `ws://127.0.0.1:${hostPort}`;
      const ws = await dial(guestWsUrl(origin, GUEST_ROUTES.control), token);
      log.debug("Microsandbox warm harness spawned", {
        role,
        slug,
        hostPort,
        ms: Math.round(performance.now() - t0),
      });
      return warmFromGuest({ proc, terminate, ws, origin, token });
    } catch (err) {
      await terminate();
      throw err;
    }
  } catch (err) {
    throw new SandboxUnavailableError(`Microsandbox spawn failed: ${errorMessage(err)}`, {
      cause: err,
    });
  }
}

export const _internals = { ..._contextInternals, realContext: defaultMicrosandboxContext };
