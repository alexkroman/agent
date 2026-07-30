// Copyright 2026 the AAI authors. MIT license.
/**
 * Limits enforced on BOTH sides of the sandbox trust boundary — the host
 * (sandbox-fetch.ts, authoritative) and the guest harness (harness-rpc.ts,
 * friendly early error). One definition so the two sides cannot drift.
 * Dependency-free: this file is bundled into the guest, so it must keep
 * zero imports (workspace or otherwise).
 */

/** Max decoded request-body size accepted from the guest (1 MB). */
export const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

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
 * How often the host pings each guest harness (`ping` notification, sent from
 * `modal-sandbox.ts` for every spawned harness — pooled, resident, and studio
 * alike). Pings are the guest's proof the host process is still alive; they
 * exist solely to feed the orphan watchdog below.
 */
export const HARNESS_HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * How long the guest harness tolerates total host silence (no stdin traffic of
 * any kind — heartbeats included) before concluding it is orphaned and
 * exiting. A host that dies without teardown (crash, OOM, SIGKILL past the
 * drain deadline, a Modal scaledown that never reaches the node process) may
 * never close the exec'd harness's stdin, so EOF alone cannot be relied on to
 * end the guest — and a harness that never exits keeps its Modal sandbox
 * "active" until the 4h lifetime cap, billing the whole way (observed in
 * production as idle sandboxes surviving for hours).
 *
 * Must stay comfortably above {@link HARNESS_HEARTBEAT_INTERVAL_MS} (5 missed
 * heartbeats) so a briefly stalled host event loop can't kill healthy guests.
 * `limits.test.ts` asserts the relationship.
 */
export const HARNESS_ORPHAN_TIMEOUT_MS = 5 * 60_000;

/** Poll cadence of the guest orphan watchdog. */
export const HARNESS_ORPHAN_POLL_MS = 30_000;

/**
 * Error for a `ctx.db` access while storage is disabled. Mirrors the SDK's
 * `STORAGE_DISABLED_MESSAGE` — same asserted-not-imported arrangement, so
 * `aai dev` and the platform read identically.
 */
export const STORAGE_DISABLED_MESSAGE =
  "Storage is not enabled for this app. Enable it with `aai storage enable` (CLI) or " +
  "the Storage toggle in the studio; under `aai dev`, set DATABASE_URL in the " +
  "project .env.";
