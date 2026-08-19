// Copyright 2026 the AAI authors. MIT license.
/**
 * The three numbers workflow uploads are measured in.
 *
 * Split from `constants.ts` for the same file-length reason
 * `client-audio-constants.ts` is, and re-exported from it, so the import path
 * every other module uses is unchanged.
 */

/**
 * Largest file `POST /workflows/uploads` accepts, unless the agent says
 * otherwise (`AAI_MAX_UPLOAD_BYTES` in its env).
 *
 * **2 GiB, and the first number here was wrong.** 256 MB was sized off a
 * two-hour 16 kHz MONO WAV (~230 MB), which describes a recording somebody
 * made deliberately for transcription and nothing else people actually have: a
 * stereo 44.1 kHz WAV of the same call is ~1.2 GB, and an hour of 24-bit audio
 * out of a recorder is over 600 MB. A cap that refuses the ordinary file is a
 * cap that makes the feature look broken, and `upload exceeds 268435456 bytes`
 * gives a person no way to know it was a POLICY rather than a limit.
 *
 * It bounds nothing about MEMORY — the body is chunked as it arrives, so an
 * oversized upload is refused mid-stream rather than buffered and then measured
 * — and nothing about the wire, which streams. What it bounds is what the app's
 * own database (or its dev directory) is asked to hold, which is why it stays a
 * number rather than becoming unlimited, and why an operator who knows their
 * storage can raise or lower it.
 *
 * Distinct from `MAX_WORKFLOW_INPUT_BYTES` (64 KB) and enormously larger, which
 * is the whole point of the split: a run's INPUT is replayed on every resume and
 * must stay tiny, while an upload is read once per step execution by whichever
 * step asks for it.
 */
export const MAX_WORKFLOW_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

/** Env key an agent raises or lowers {@link MAX_WORKFLOW_UPLOAD_BYTES} with. */
export const MAX_UPLOAD_BYTES_ENV = "AAI_MAX_UPLOAD_BYTES";

/**
 * How much of an upload one stored row (or one write) holds.
 *
 * The unit a range read's cost is measured in: reading any window touches the
 * chunks it overlaps, and the Postgres backend then slices INSIDE them, so this
 * is the granularity of the index rather than of the transfer. A megabyte keeps
 * the row count of a 230 MB recording in the low hundreds while staying well
 * inside what a single `bytea` value and one round trip should carry.
 */
export const UPLOAD_CHUNK_BYTES = 1024 * 1024;

/**
 * How much of a file one PART of a parallel upload carries, by default.
 *
 * The number trades two costs against each other. Too small and an upload is
 * mostly per-request overhead — a `POST`, a round trip, a write per 8 MB is
 * nothing, a write per 64 KB is the upload. Too large and the parallelism
 * disappears: a 20 MB recording split into 32 MB parts is one part, which is the
 * single request this exists to beat, and a part that fails is a part that has to
 * be sent again in full.
 *
 * 8 MiB is eight chunks, so a part is a handful of stored rows; it keeps a
 * 200 MB recording at 25 parts (comfortably more than the concurrency below, so
 * every connection stays fed), and it is the size the object stores this shape
 * comes from settled on for the same reasons.
 */
export const UPLOAD_PART_BYTES = 8 * 1024 * 1024;

/**
 * How many parts a parallel upload keeps in flight, by default.
 *
 * **Four, and it is now MEASURED — the knee and a hard ceiling land in the same
 * place.** `pnpm bench:uploads` (`scripts/upload-sweep.mjs`) against a deployed
 * agent on the managed platform, 32 MiB in 2 MiB parts, two runs per width:
 *
 * | in flight | wall p50 | range | MB/s | part p50/p95 | h2 resets |
 * | --- | --- | --- | --- | --- | --- |
 * | 1 request | 11.6s | 11.5-11.6s | 2.8 | — | 0 |
 * | 1 | 49.7s | 49.1-50.2s | 0.6 | 1.41s / 2.73s | 0 |
 * | 2 | 20.7s | 19.6-21.8s | 1.5 | 1.28s / 1.97s | 0 |
 * | 4 | 14.0s | 13.6-14.4s | 2.3 | 1.63s / 2.88s | 0 |
 * | 8 | 13.1s | 8.5-17.7s | 2.4 | 2.81s / 4.38s | 10 |
 * | 16 | — | 0 of 2 landed | — | — | 63 |
 *
 * The shape the old prose GUESSED is roughly right — steep, then flat — and the
 * number it guessed survives. What it could not know is why the flat part is flat.
 * 1 → 4 is 3.5x. 4 → 8 buys nothing measurable (13.1s against 14.0s, inside 8's own
 * 2.1x spread) and starts paying stream resets. 16 does not complete at all.
 *
 * **The ceiling is HTTP/2, and it is not the browser connection limit this used to
 * cite.** Both halves of that sentence were wrong. A browser's six-per-origin cap is
 * an HTTP/1.1 rule, and the origin here speaks h2 — to Node's `fetch` and to a page
 * alike — so the real limit is the server's concurrent-stream budget, and it does not
 * answer with a status. It answers `NGHTTP2_ENHANCE_YOUR_CALM`, a STREAM RESET, which
 * surfaces as a bare `TypeError: fetch failed` and is invisible to both
 * {@link UPLOAD_RETRY_MAX_MS}'s `Retry-After` handling and `RETRYABLE_STATUS`: there
 * is no response to read. `withRetries` still re-sends it as a transport failure, which
 * is what absorbs the ten at width 8 — and at 16 every sibling collides into the same
 * reset and the budget is gone. `sdk/step-fetch.ts` documents this exact failure and
 * pins HTTP/1.1 to escape it; the upload path CANNOT, because half its callers are
 * pages. So four is not merely where the gain stops, it is under the cliff.
 *
 * Two honest limits on the table. It is ONE link on one afternoon at two runs a cell,
 * so it bounds the shape rather than pinning the knee to the megabyte — the 8-wide row
 * spans 2.1x on its own and the sweep says so rather than reporting its median. And the
 * `1 request` row is not the win it looks like: one stream never collides, so it beats
 * every fan-out on a path whose bottleneck is the far side rather than the uplink. Both
 * are reasons to RE-RUN before this number moves, not reasons to move it.
 */
export const UPLOAD_PART_CONCURRENCY = 4;

/**
 * How many times a request on the parts path is sent before the upload gives up.
 *
 * A parallel upload has N connections' worth of chances to lose one, which is the
 * cost of the speed — so retrying is what makes the shape pay: the store accepts a
 * repeated part as the same part (its rows are keyed by offset), a transient
 * failure is the ordinary reason a part dies, and the alternative is throwing away
 * every other part that already landed.
 *
 * **Four, and two was too few for the reason the backoff exists.** The argument for
 * two was that "a second failure is a signal about the link rather than a
 * coincidence" — true of a link, and false of the failure this actually meets,
 * which is a guest at capacity answering 503. Those arrive in BURSTS, because a
 * fan-out hits the limit together, and the old budget spent its one retry
 * immediately: two rejections a few milliseconds apart, from a server whose own
 * answer said to come back. With {@link UPLOAD_RETRY_BASE_MS} between them the
 * attempts sample a window of seconds rather than of milliseconds, which is the
 * thing being waited out. Four of those is ~4-11s before a part is called lost —
 * against an upload measured in minutes, and against the alternative of losing all
 * of it.
 */
export const UPLOAD_PART_ATTEMPTS = 4;

/**
 * The first backoff between attempts, doubling from there.
 *
 * Half a second is above the round trip that just failed and far under the poll
 * a run watching this upload is on, so a retried part is invisible to everything
 * except the thing it is waiting out.
 */
export const UPLOAD_RETRY_BASE_MS = 500;

/**
 * The longest wait between attempts, `Retry-After` included.
 *
 * The far side's own number is honoured up to here and no further: the agent's
 * 503s carry single-digit seconds, and something upstream of it that asks for two
 * minutes is asking a person watching an upload bar to wait longer than they will.
 * Ten seconds keeps the whole budget (~4-11s of waiting over four attempts) shorter
 * than the time it would take to notice and start the upload again by hand.
 */
export const UPLOAD_RETRY_MAX_MS = 10_000;

/**
 * Prefix every upload id carries.
 *
 * So a stray value in a log, a run input or an error reads as what it is — the
 * same reason a run id is `wrun_`-prefixed.
 */
export const UPLOAD_ID_PREFIX = "upl_";

/**
 * What a caller-chosen upload id may contain.
 *
 * Almost every upload id is minted here (`newUploadId`), and one kind is not: a
 * STREAMED upload is named by its caller, because the whole point is that the run
 * can start before the bytes have finished arriving — so the id has to exist
 * before the upload does, travel in the run input, and be the thing the two find
 * each other by.
 *
 * That makes it attacker-controlled text in a place the store treats as
 * structural: a primary key in Postgres, and a FILENAME in the file backend, where
 * `../../etc/passwd` would escape the store entirely. So the shape is an
 * allow-list rather than an escape — alphanumerics, `-` and `_`, which is what a
 * `crypto.randomUUID()` already is and what leaves nothing for a path to
 * interpret. Enforced at the ROUTE and again in the store, because the store is
 * also reachable from a step and from a test.
 *
 * 64 characters is twice a hyphenless UUID with room for a caller's own prefix.
 */
export const UPLOAD_TOKEN_RE = /^[A-Za-z0-9_-]{1,64}$/;
