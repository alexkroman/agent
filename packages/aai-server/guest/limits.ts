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
