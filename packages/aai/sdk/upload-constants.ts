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
 * The whole point is to beat one connection, and the gain is steep at first and
 * then flat: the bottleneck moves from per-connection window scaling to the link
 * itself somewhere around four, and past that the parts mostly compete with each
 * other for the same bandwidth while multiplying the writes the agent is doing at
 * once. Four is also inside every browser's per-origin connection limit (six),
 * which leaves room for the page's own requests — a page that spends all six on
 * one upload cannot poll the run it just started.
 */
export const UPLOAD_PART_CONCURRENCY = 4;

/**
 * How many times a part is sent before the upload gives up on it.
 *
 * A parallel upload has N connections' worth of chances to lose one, which is the
 * cost of the speed — so ONE retry is what makes the shape pay: the store accepts
 * a repeated part as the same part (its rows are keyed by offset), a transient
 * failure is the ordinary reason a part dies, and the alternative is throwing away
 * every other part that already landed. Two attempts rather than more because a
 * second failure is a signal about the link rather than a coincidence, and a
 * caller waiting on a form would rather be told.
 */
export const UPLOAD_PART_ATTEMPTS = 2;

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
