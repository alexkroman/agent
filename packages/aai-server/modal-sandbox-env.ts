// Copyright 2026 the AAI authors. MIT license.
/**
 * Env-derived Modal sandbox configuration: resource limits and region
 * pinning, parsed once per spawn by `modal-sandbox.ts`. Split out of that
 * module so the spawn/transport wiring stays focused; nothing here talks to
 * Modal — it only turns operator environment variables into
 * `SandboxCreateParams` fields.
 */

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
 * Idle detection can only kick in once the harness exec has actually exited,
 * and that is the link that failed in production: stdin EOF is not reliably
 * delivered to the exec'd process when the host dies, and even when it is, a
 * loaded bundle's own timers could hold Deno's event loop open — so orphaned
 * harnesses kept "running" and their sandboxes never read as idle, surviving
 * for hours. The guest therefore no longer relies on EOF: the host heartbeats
 * every harness (`ping` each `HARNESS_HEARTBEAT_INTERVAL_MS`, wired in
 * `modal-sandbox.ts:warmFromModal`), and the harness self-exits after
 * `HARNESS_ORPHAN_TIMEOUT_MS` of host silence and hard-exits on EOF
 * (`guest/deno-harness.ts`) — after which this timer is what terminates the
 * sandbox.
 *
 * A *healthy* resident sandbox always has the harness exec running (and its
 * host pinging), so its idle timer never starts; host-side eviction
 * (`sandbox-slots.ts`) remains the authority on session-aware idleness.
 * Override with `SANDBOX_IDLE_TIMEOUT_SECS`.
 */
export const DEFAULT_SANDBOX_IDLE_TIMEOUT_MS = 15 * 60 * 1000;

export type ModalSandboxLimits = {
  /** Hard memory cap in MiB (Modal `memoryLimitMiB`). */
  memoryLimitMiB?: number;
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
  ["SANDBOX_MEMORY_LIMIT_MB", "memoryLimitMiB", 128, 4096, 1],
  ["SANDBOX_CPU_LIMIT", "cpuLimit", 0.125, 16, 1],
  ["SANDBOX_TIMEOUT_SECS", "timeoutMs", 300, 86_400, 1000],
  ["SANDBOX_IDLE_TIMEOUT_SECS", "idleTimeoutMs", 60, 86_400, 1000],
];

/**
 * Parses operator sandbox limit overrides from environment variables.
 * Unset or non-numeric vars are ignored (Modal defaults / our default
 * lifetime apply). Values are clamped, then scaled to the field's unit.
 */
export function parseSandboxLimitsFromEnv(
  env: Record<string, string | undefined>,
): ModalSandboxLimits {
  const limits: ModalSandboxLimits = {};
  for (const [envVar, key, min, max, scale] of LIMIT_SPECS) {
    const value = Number(env[envVar]);
    if (Number.isFinite(value)) limits[key] = clamp(value, min, max) * scale;
  }
  return limits;
}

/**
 * Parses guest-sandbox region pinning from `MODAL_SANDBOX_REGION`
 * (comma-separated for multiple acceptable regions, e.g. `"us-east-1"`).
 *
 * Unpinned, Modal places sandboxes wherever it finds capacity — including a
 * different continent and cloud than the platform server (observed:
 * server in us-east-1/AWS, sandboxes in uk-london-1/OCI). The host↔guest
 * NDJSON link over Modal's command router is a network hop, so every
 * `ctx.db` query, Vector call, guest fetch proxy, and `bundle/load` pays
 * that RTT — serialized inside the LLM loop of a latency-budgeted voice
 * turn. `modal_deploy.py` sets this variable to the same region constant
 * that pins the web server, so production host and guests are co-located
 * by construction; local dev stays unpinned.
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
