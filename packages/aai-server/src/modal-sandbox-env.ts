// Copyright 2026 the AAI authors. MIT license.
/**
 * Env-derived Modal sandbox configuration: resource limits and region
 * pinning, parsed once per spawn by `modal-sandbox.ts`. Split out of that
 * module so the spawn/transport wiring stays focused; nothing here talks to
 * Modal — it only turns operator environment variables into
 * `SandboxCreateParams` fields.
 */

import { omitUndefined } from "@alexkroman1/aai/utils";

/**
 * Default max sandbox lifetime. Modal's own default (5 minutes) is far too
 * short for a voice agent slot that serves sessions across hours; the slot
 * layer replaces a sandbox that dies, so this is a backstop, not a session
 * limit. Override with `SANDBOX_TIMEOUT_SECS`.
 */
export const DEFAULT_SANDBOX_TIMEOUT_MS = 4 * 60 * 60 * 1000;

/**
 * Default Modal-side idle termination (Modal `idleTimeoutMs`) — the native
 * orphan reaper. If this server process dies without running its shutdown
 * teardown (crash, OOM, SIGKILL past the drain deadline, a scaledown that
 * never reaches the node process), the in-memory slot cache is gone and
 * nothing host-side will ever terminate the remote sandboxes; once no exec is
 * running in a sandbox, Modal's idle timer reaps it after this window instead
 * of billing until the 4h lifetime cap.
 *
 * Idle detection can only kick in once the harness exec has actually exited
 * (Modal counts a running exec, stdin writes, and open tunnel TCP connections
 * as activity — the `sleep infinity` entrypoint does not count). The host's
 * control WebSocket is the liveness signal: a host that dies drops it, and
 * the harness self-exits after `HARNESS_ORPHAN_TIMEOUT_MS` (5 min) with no
 * host connected (`aai-guest/harness.ts`) — after which this timer is what
 * terminates the sandbox. So an ungracefully killed replica's guests linger
 * as ~2-3 MiB `sleep infinity` shells for orphan timeout + idle window
 * (~20 min) before Modal reaps them. That window is the backstop, not the
 * normal path: `run_node` in scripts/modal_image.py forwards container stop
 * signals to the node process so `teardownSandboxes` runs on
 * scale-in/redeploy — RETIRING agent guests (they finish their calls and
 * exit themselves) and terminating studio guests via the broker.
 *
 * A *healthy* resident sandbox always has the harness exec running, so its
 * idle timer never starts; the GUEST owns idleness (agent-mode self-exit).
 * Override with `SANDBOX_IDLE_TIMEOUT_SECS`.
 */
export const DEFAULT_SANDBOX_IDLE_TIMEOUT_MS = 15 * 60 * 1000;

export type ModalSandboxLimits = {
  /** Memory *reservation* in MiB (Modal `memoryMiB`) — what the guest is billed. */
  memoryMiB?: number;
  /** Hard memory cap in MiB (Modal `memoryLimitMiB`). */
  memoryLimitMiB?: number;
  /** CPU-core *reservation* (Modal `cpu`), can be fractional. */
  cpu?: number;
  /** Hard CPU-core cap, can be fractional (Modal `cpuLimit`). */
  cpuLimit?: number;
  /** Max sandbox lifetime in ms (Modal `timeoutMs`). */
  timeoutMs?: number;
  /** Modal-side idle termination in ms (Modal `idleTimeoutMs`) — see
   * {@link DEFAULT_SANDBOX_IDLE_TIMEOUT_MS} for why this exists. */
  idleTimeoutMs?: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// Table form on purpose: with one copy-pasted block per variable, mismatched
// clamp bounds are invisible in review — the table makes each row's
// env var → field, [min, max] clamp, and unit scale line up for comparison.
const LIMIT_SPECS: readonly [
  envVar: string,
  key: keyof ModalSandboxLimits,
  min: number,
  max: number,
  scale: number,
][] = [
  ["SANDBOX_MEMORY_MB", "memoryMiB", 128, 4096, 1],
  ["SANDBOX_MEMORY_LIMIT_MB", "memoryLimitMiB", 128, 4096, 1],
  ["SANDBOX_CPU", "cpu", 0.125, 16, 1],
  ["SANDBOX_CPU_LIMIT", "cpuLimit", 0.125, 16, 1],
  ["SANDBOX_TIMEOUT_SECS", "timeoutMs", 300, 86_400, 1000],
  ["SANDBOX_IDLE_TIMEOUT_SECS", "idleTimeoutMs", 60, 86_400, 1000],
];

/** Reservation → cap pairs, and the env vars that set them. */
const RESOURCE_PAIRS: readonly [
  reservation: "memoryMiB" | "cpu",
  reservationVar: string,
  cap: "memoryLimitMiB" | "cpuLimit",
  capVar: string,
][] = [
  ["memoryMiB", "SANDBOX_MEMORY_MB", "memoryLimitMiB", "SANDBOX_MEMORY_LIMIT_MB"],
  ["cpu", "SANDBOX_CPU", "cpuLimit", "SANDBOX_CPU_LIMIT"],
];

/**
 * Modal rejects a reservation above its own cap, so pull each one down. Kept
 * out of {@link assertModalResourcePairs} because it is backend-agnostic
 * arithmetic — the subprocess backend reads `memoryLimitMiB` too.
 */
function clampReservationsToCaps(limits: ModalSandboxLimits): void {
  for (const [reservation, , cap] of RESOURCE_PAIRS) {
    const capped = limits[cap];
    const reserved = limits[reservation];
    if (capped !== undefined && reserved !== undefined) {
      limits[reservation] = Math.min(reserved, capped);
    }
  }
}

/**
 * Rejects a hard cap with no reservation beside it — a MODAL rule, which is
 * why it lives at that backend's spawn and not in the shared parser: the
 * subprocess backend honors `memoryLimitMiB` alone and has nothing to
 * reserve. Modal's SDK fails creation with "must also specify cpu when
 * cpuLimit is specified", so the spawn dies either way; the choice is only
 * between naming the env var to set and surfacing Modal's message about
 * parameters the operator never wrote.
 */
export function assertModalResourcePairs(limits: ModalSandboxLimits): void {
  for (const [reservation, reservationVar, cap, capVar] of RESOURCE_PAIRS) {
    if (limits[cap] !== undefined && limits[reservation] === undefined) {
      throw new Error(`${capVar} requires ${reservationVar} to be set (Modal rejects a bare cap)`);
    }
  }
}

/**
 * Parses operator sandbox limit overrides from environment variables.
 * Unset or non-numeric vars are ignored (Modal defaults / our default
 * lifetime apply). Values are clamped, then scaled to the field's unit.
 *
 * **Reservation and cap are separate knobs on purpose** — `SANDBOX_MEMORY_MB`
 * / `SANDBOX_CPU` reserve, `SANDBOX_MEMORY_LIMIT_MB` / `SANDBOX_CPU_LIMIT`
 * cap. A guest's load is bimodal: it idles as a voice session at ~260 MB on a
 * fraction of a core, then spikes to ~1.7 GB across several cores for the
 * seconds a `test_agent` or Publish build spends in the bundler. While the
 * reservation was pinned equal to the cap, those two numbers had to be one
 * number, and the affordable one (1 GiB / 1 core) could not fit a build: the
 * guest wedged at its cgroup ceiling in permanent direct-reclaim, burning a
 * core on back-to-back full GCs that could never free rolldown's *native*
 * Rust allocations. It reads as a hang, not an OOM, and it takes down both
 * build paths at once — the cap is on the cgroup, so moving the bundler into
 * a child process cannot escape it.
 */
export function parseSandboxLimitsFromEnv(
  env: Record<string, string | undefined>,
): ModalSandboxLimits {
  const limits: ModalSandboxLimits = {};
  for (const [envVar, key, min, max, scale] of LIMIT_SPECS) {
    const value = Number(env[envVar]);
    if (Number.isFinite(value)) limits[key] = clamp(value, min, max) * scale;
  }
  clampReservationsToCaps(limits);
  return limits;
}

/**
 * Parses guest-sandbox region pinning from `MODAL_SANDBOX_REGION`
 * (comma-separated for multiple acceptable regions, e.g. `"us-east-2"`, or a
 * granularity level like `"us-east"`). The value is not validated here: Modal
 * checks region strings server-side and refuses one it does not support
 * (`Regions us-east-1 are not supported`), so an operator setting this is
 * choosing from Modal's list, not from anything in this tree.
 *
 * **Production leaves this UNSET on purpose** — an operator override, not a
 * deployed default. Pinning trades placement capacity for locality, and
 * capacity is the scarcer of the two: a spawn Modal cannot schedule in the
 * ~50s `sandbox.tunnels()` waits fails the whole session with
 * `Sandbox operation timed out`, which is what pinning every guest to the
 * web server's single region produced under load.
 *
 * The locality it bought is real but narrower than it looks. Unpinned, Modal
 * places sandboxes wherever it finds capacity — including a different
 * continent and cloud than the platform server (observed: server in
 * us-east-1/AWS, sandboxes in uk-london-1/OCI). But AGENT guests hold no
 * host channel at all: voice clients dial the sandbox tunnel directly, so a
 * voice turn crosses the host↔guest hop zero times. Only the STUDIO's
 * control-channel RPCs pay the RTT, and those are not inside a latency
 * budget the way a voice turn is. Set it (comma-separated for several
 * acceptable regions) when an environment wants locality back.
 */
export function parseSandboxRegionsFromEnv(
  env: Record<string, string | undefined>,
): string[] | undefined {
  const regions = (env.MODAL_SANDBOX_REGION ?? "")
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
  return regions.length > 0 ? regions : undefined;
}

/**
 * The guest sandbox's resource create-params, assembled from env in ONE
 * place: reservation + cap pairs (validated — see
 * {@link assertModalResourcePairs}: reservation and cap are a burst range,
 * not one number; a guest idles as a voice session and spikes only while
 * the bundler runs) plus region pinning. Every Modal sandbox create spreads
 * this, so a new resource knob is added once, not per spawn path. Returns
 * the parsed `limits` alongside for the per-path timeout fields.
 */
export function guestSandboxResources(env: NodeJS.ProcessEnv): {
  limits: ModalSandboxLimits;
  resourceParams: {
    memoryMiB?: number;
    memoryLimitMiB?: number;
    cpu?: number;
    cpuLimit?: number;
    regions?: string[];
  };
} {
  const limits = parseSandboxLimitsFromEnv(env);
  assertModalResourcePairs(limits);
  const regions = parseSandboxRegionsFromEnv(env);
  return {
    limits,
    resourceParams: {
      ...omitUndefined({
        memoryMiB: limits.memoryMiB,
        memoryLimitMiB: limits.memoryLimitMiB,
        cpu: limits.cpu,
        cpuLimit: limits.cpuLimit,
      }),
      // Co-locate guests with the host — see parseSandboxRegionsFromEnv.
      ...omitUndefined({ regions }),
    },
  };
}
