// Copyright 2026 the AAI authors. MIT license.
/**
 * Limits enforced in the guest harness. One definition so the guest and any
 * host-side mirror cannot drift. Dependency-free: this file is bundled into
 * the guest, so it must keep zero imports (workspace or otherwise).
 */

/**
 * Wall-clock cap for a single `run_code` execution, enforced in the guest (the
 * only place `run_code` runs — see SANDBOX_ONLY_BUILTINS). This is the sole
 * definition; the SDK has no host-side counterpart.
 */
export const RUN_CODE_TIMEOUT_MS = 5000;

/**
 * Wall-clock cap for a single guest tool execution. Mirrors the SDK's
 * `TOOL_EXECUTION_TIMEOUT_MS` — same asserted-not-imported arrangement.
 */
export const TOOL_TIMEOUT_MS = 30_000;

/**
 * How long the guest harness tolerates having no host WebSocket connected
 * before concluding it is orphaned and exiting. The connection itself is the
 * liveness signal: a host that dies without teardown (crash, OOM, SIGKILL
 * past the drain deadline) drops the socket, and the harness must not keep
 * its Modal sandbox alive to the lifetime cap, billing the whole way. The
 * window also covers the boot gap between the harness starting to listen and
 * the host's first dial (pool spawns dial within seconds).
 */
export const HARNESS_ORPHAN_TIMEOUT_MS = 5 * 60_000;

/** Poll cadence of the guest orphan check. */
export const HARNESS_ORPHAN_POLL_MS = 30_000;

/**
 * Version of the AGENT-MODE guest contract: the exec-env boot convention
 * (AAI_GUEST_MODE / AAI_BUNDLE_PATH / AAI_BUNDLE_SHA256 / AAI_AGENT_ENV_PATH)
 * plus the token-gated `/manage/*` HTTP surface. Reported by
 * `GET /manage/status`. Agent sandboxes run the harness image PINNED at
 * deploy time, so the host may be newer than this harness — bump this on any
 * change to the surface, and keep host-side consumers tolerant of older
 * versions (additive changes only).
 */
export const GUEST_CONTRACT_VERSION = 1;

/**
 * Agent-mode idle self-exit: with zero live sessions for this long the guest
 * exits 0 so Modal's idle timeout reclaims the sandbox. Agent-mode guests
 * have NO host control connection (the server contract is HTTP-only), so the
 * orphan-timeout mechanism cannot apply — and the guest is the ONLY idle
 * reclaimer (the host-side idle sweep was deleted; the guest's exit
 * surfaces host-side as process death → onSandboxLost detaches the slot).
 * Overridable via AAI_GUEST_IDLE_EXIT_MS, which the spawner forwards from
 * the server's own env (`agentBootEnv` in aai-server/warm-harness.ts) — a
 * guest reads only what it is handed at exec, so setting it on the platform
 * process is what reaches every backend. 0 disables.
 */
export const AGENT_IDLE_EXIT_MS = 5 * 60_000;

/** Poll cadence of the agent-mode idle/drain check. */
export const AGENT_IDLE_POLL_MS = 5000;

/**
 * Error for a `ctx.db` access while storage is disabled. Mirrors the SDK's
 * `STORAGE_DISABLED_MESSAGE` — same asserted-not-imported arrangement, so
 * `aai dev` and the platform read identically.
 */
export const STORAGE_DISABLED_MESSAGE =
  "Storage is not enabled for this app. Enable it with `aai storage enable` (CLI) or " +
  "the Storage toggle in the studio; under `aai dev`, set DATABASE_URL in the " +
  "project .env.";

/**
 * Studio workspace caps, mirroring `studio-limits.ts` in aai-studio-server
 * (same asserted-not-imported arrangement as the SDK constants above): the
 * guest materializes and syncs workspaces and must enforce the same shape
 * the host store accepts, without importing server code.
 */
export const MAX_STUDIO_FILES = 100;
/** Max bytes for a single workspace file. */
export const MAX_STUDIO_FILE_BYTES = 256_000;
