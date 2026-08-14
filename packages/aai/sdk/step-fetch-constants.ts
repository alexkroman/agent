// Copyright 2026 the AAI authors. MIT license.
/**
 * How `stepFetch`'s connection pool is sized.
 *
 * Split from `constants.ts` for the same file-length reason
 * `client-audio-constants.ts` and `upload-constants.ts` are, and re-exported
 * from it, so the import path every other module uses is unchanged. What the
 * pool is FOR — and why HTTP/1.1 at all — is `sdk/step-fetch.ts`.
 */

/**
 * Connections `stepFetch`'s pool may hold open per origin.
 *
 * Sized against a workflow fan-out rather than a session: `mapInBatches` issues
 * a whole batch at once and each call wants a socket of its own (that being the
 * point — see `sdk/step-fetch.ts`), so this has to clear the widest batch anyone
 * reasonably runs. Measured on AssemblyAI's sync endpoint, throughput plateaus
 * around 32 in flight and the far side starts refusing past ~48, so 64 is above
 * anything worth attempting and is a cap rather than a target.
 *
 * @internal
 */
export const STEP_FETCH_CONNECTIONS = 64;

/**
 * How long `stepFetch` keeps an idle connection.
 *
 * A fan-out's batches arrive seconds apart, so the pool has to survive the gap
 * between them or every batch pays a fresh TLS handshake — worth ~20% of wall
 * time in the measurements `sdk/step-fetch.ts` records. Thirty seconds covers
 * the gap without holding sockets against a provider for the life of a mostly
 * idle process.
 *
 * @internal
 */
export const STEP_FETCH_KEEP_ALIVE_MS = 30_000;

/**
 * Requests `stepFetch` will pipeline on one connection.
 *
 * **One, deliberately.** Pipelining is the HTTP/1.1 shape of the very thing this
 * fetch exists to avoid: several requests queued on a single connection, where a
 * slow or reset one holds up the rest. A fan-out wants N connections, not N
 * requests on one.
 *
 * @internal
 */
export const STEP_FETCH_PIPELINING = 1;
