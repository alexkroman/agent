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
