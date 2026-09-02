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

/**
 * How long `stepFetch` tolerates a request making NO PROGRESS.
 *
 * This pool used to set undici's `headersTimeout` and `bodyTimeout` to `0` —
 * off — on the argument that *"a step owns its own deadline: an `AbortSignal` it
 * passes, or the DevKit's step budget."* The second clause was retired with the
 * DevKit, and it was the only one that covered a step which passes no signal. So
 * a user-written `stepFetch` call had a deadline from **no layer at all** — not
 * undici, not the engine (`attemptLoop` hands the body no signal) — and hung
 * until the process died. The SDK's own helpers were never exposed: every one of
 * them passes `AbortSignal.timeout(...)`.
 *
 * ## It is an INACTIVITY bound, which is why one number can serve every file
 *
 * The instinctive fix is a total-duration default, and it cannot be sized: a
 * legitimate upload's duration is a function of its bytes, and the same 660 MiB
 * recording measured **3m21s on one run and 15m on another** — a 4.5x throughput
 * spread against the same endpoint. Any total-duration number is therefore either
 * too tight for a big file or useless for a small one.
 *
 * Both of undici's timers are PHASE/INACTIVITY timers instead, so neither scales
 * with the file (`client-h1.js`, undici 8):
 *
 * - While the request body is being written, `headersTimeout` is REFRESHED at
 *   every backpressured chunk write (`write()` calls `timeout.refresh()` when
 *   `socket.write` returns false), and `onParserTimeout` declines to destroy the
 *   socket at all while `socket[kWriting]` is true and `writableNeedDrain` is
 *   false. So it fires only when a write has been blocked this long with no
 *   drain — a stalled link, not a slow one.
 * - Once the request is fully sent it becomes "no response headers for this
 *   long", and `bodyTimeout` is "no response-body bytes for this long".
 *
 * ## Why ten minutes
 *
 * The number has to clear two things, and both are bounded and small:
 *
 * - **One window of a healthy transfer.** `stepTranscribeUpload` writes
 *   `TRANSCRIBE_WINDOW_BYTES` (4 MiB) per chunk, so the write-phase timer is
 *   refreshed once per window. The SLOW end of the measurement above is
 *   660 MiB / 15 min ≈ 0.73 MB/s, i.e. ~5.6 s per window; for ten minutes to
 *   elapse between windows the link would have to fall to ~7 kB/s — a ~100x
 *   collapse below the slow end of an already 4.5x spread. That is a dead
 *   connection, and calling it one is the whole point.
 * - **The longest server think-time anything here can produce.** The sync
 *   transcription endpoint holds the connection while it works and caps itself at
 *   120 seconds by contract (`TRANSCRIBE_SYNC_TIMEOUT_MS`); a non-streaming
 *   gateway completion is well inside that. Ten minutes is 5x the longest
 *   documented ceiling, so a provider has to be far outside its own contract
 *   before this truncates it — and undici's own 300s default, the value this pool
 *   was turned off to escape, is only 2.5x.
 *
 * A caller that wants a TOTAL bound still passes a signal, and the SDK's helpers
 * do. This is the floor under the callers that pass none.
 *
 * @internal
 */
// 10 minutes, spelled as the literal rather than as `10 * 60_000`: an arithmetic
// initializer widens to `number`, which drops the VALUE out of the rolled-up
// .d.ts. See "Value-carrying constants carry a LITERAL type" in AGENTS.md.
export const STEP_FETCH_INACTIVITY_MS = 600_000;
