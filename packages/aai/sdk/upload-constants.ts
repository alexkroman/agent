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
 * **8 MiB, and it stays there because a part pays a FIXED cost that has nothing to
 * do with its size.** On the direct path (a deployed agent — see
 * `_upload-blobs-brokered.ts`) every part is two requests: the window goes to the
 * platform, and a body-less `PUT …/parts?offset=…&stored=1` tells the agent it
 * landed. Measured against a deployed agent, per 4 MiB part:
 *
 * | | time | rate |
 * | --- | --- | --- |
 * | byte `PUT` to the platform | 926-2121 ms | 1.9-4.3 MB/s |
 * | `stored=1` claim, brokered to the guest | 1604-1969 ms | no body at all |
 *
 * So roughly half a part's wall time is a round trip carrying nothing, and it is
 * per-PART rather than per-byte. Halving this constant doubles how many times that
 * toll is paid: the same 32 MiB costs four claims at 8 MiB and eight at 4 MiB.
 * Extrapolated over a 660 MB recording at width 8, 8 MiB parts finish in ~38s
 * against ~56s for 4 MiB ones — the fixed cost dominates, and it dominates harder
 * the smaller the part.
 *
 * **This reverses a first attempt at 4 MiB**, which reasoned that a smaller window
 * makes a reset cheaper (true, and measured: at four wide, 8 MiB bodies reset where
 * 4 MiB, 2 MiB and 1 MiB passed). It is the right trade only if the part's cost is
 * mostly its bytes, and it is not. The claim is the argument for not going smaller.
 *
 * ## And 16 MiB measures BETTER, which is not the same as being right
 *
 * Three runs per size, alternating order so a drifting link cannot favour one, one
 * part per run:
 *
 * | part | per-byte rate | median | spread |
 * | --- | --- | --- | --- |
 * | 8 MiB | 2.5, 2.1, 3.8 MB/s | 2.5 | 1.8x |
 * | 16 MiB | 3.2, 3.3, 3.2 MB/s | **3.2** | **1.03x** |
 * | 32 MiB | 2.9, 4.0, 2.0 MB/s | 2.9 | 2.0x |
 *
 * 16 MiB is ~28% quicker per byte than 8 and far more predictable — a small transfer
 * never leaves TCP slow-start, which is also why 4 MiB was the worst of all four
 * sizes measured (1.8 MB/s). 32 MiB buys nothing over 16 and is the noisiest.
 *
 * It is not taken, because the number the platform reacts to is the PRODUCT with
 * `UPLOAD_PART_CONCURRENCY`, and three costs land on it rather than on the
 * size alone:
 *
 * - **Platform memory.** `_upload-blobs-http.ts` buffers a whole window to hand
 *   Storage a length — unavoidable, and the reason the cap is a window rather than a
 *   file. At eight wide, 16 MiB parts ask a shared memory-bounded process to hold
 *   128 MiB for ONE upload.
 * - **The reset shoulder.** 128 MiB in flight is the row where a reset appeared
 *   (31 of 32); 64 MiB, which eight 8 MiB parts hold, did not.
 * - **The parallelism FLOOR.** `partsPlan` declines a plan of fewer than two parts,
 *   so this constant sets the size below which a file takes the single request and
 *   gets no retry at all. At 8 MiB that floor is 16 MB; at 16 MiB it is 32 MB, which
 *   is a regression for every recording in between.
 *
 * So the order to do this in is: batch the claims, then re-measure. Batching removes
 * the fixed toll that makes a larger part attractive, and the 28% is then weighed
 * against those three costs on its own rather than bundled with a round trip.
 *
 * The real lever is neither, and it is not a constant: **batch the claims.** One
 * request naming several landed offsets would collapse N tolls into one, and the
 * platform cannot record a part itself — the record lives in the app's own database,
 * which only the guest can reach, which is exactly why the guest is told. Until
 * then this number is a compromise with a round trip.
 *
 * Two costs of the size that are unchanged and still real: too small and an upload
 * is mostly per-request overhead, too large and the parallelism disappears (a 20 MB
 * recording in 32 MB parts is one part, which is the single request this exists to
 * beat, and a failed part is re-sent in full).
 *
 * **Legal against any server version, in both directions.** `assertPartOffset`
 * aligns on {@link UPLOAD_CHUNK_BYTES} (1 MiB), never on this — so a client cutting
 * at 4 MiB is accepted by a server that cuts at 8, and the reverse. Check that
 * before moving this; alignment on the part size would make it a wire break.
 */
export const UPLOAD_PART_BYTES = 8 * 1024 * 1024;

/**
 * How many parts a parallel upload keeps in flight, by default.
 *
 * **Eight, doubled from four, and it is the one knob that pays here.** Every part on
 * the direct path costs a fixed ~1.7s body-less round trip to the guest on top of
 * its bytes ({@link UPLOAD_PART_BYTES} carries the table). That toll is per-part and
 * independent of size, so the only thing that hides it is OVERLAP — which is what
 * this number is. Extrapolated over a 660 MB recording: ~77s at four wide against
 * ~38s at eight.
 *
 * ## Why not wider, which is the obvious question
 *
 * Three reasons, and the first is the one that would still hold on a faster link:
 *
 * - **One reset aborts every sibling in flight.** `uploadInParts` fails the whole
 *   upload on the first failure — deliberately, so bytes nobody will read stop
 *   going — so width is the BLAST RADIUS of a single reset, not just a throughput
 *   knob. At 32 wide, one window's reset discards 31 in-flight windows.
 * - **Resets track bytes in flight, and eight is already 64 MiB of it.** Measured
 *   against a deployed agent on a fresh connection: 32 MiB outstanding passed clean
 *   at every part size tried, 64 MiB passed at lower per-byte throughput, 128 MiB
 *   passed 31 of 32 with one reset. Eight sits on the shoulder of that curve rather
 *   than under it, which is the deliberate half of this choice — 16 would be 128 MiB
 *   and the row where a reset appeared.
 * - **Sustained throughput is METERED, so width cannot buy it.** Over one sweep
 *   the same 32 MiB upload went 6.5 -> 4.7 -> 3.5 -> 3.2 -> 1.9 MB/s on fresh
 *   pinned-h1 connections 30s apart, across a width change, against a link
 *   measured at 13.6 MB/s to an unrelated host. Width changes how fast the bucket
 *   drains, not how fast it refills — so paying blast radius for throughput the
 *   meter takes back is a bad trade.
 *
 * A caller who knows their link can still pass `parallel: { concurrency }`. What a
 * DEFAULT has to be is safe on the worst link, and the reset is invisible to the
 * classifier: it carries no HTTP status, so neither `RETRYABLE_STATUS` nor
 * `Retry-After` sees it and `withRetries` can only treat it as a transport failure.
 *
 * ## The table that used to be here was measuring its own contamination
 *
 * It reported `8 -> 10 h2 resets` and `16 -> 0 of 2 landed, 63 resets`, and
 * concluded four sat "under the cliff". That cliff was an artifact.
 * `scripts/upload-sweep.mjs` reused ONE connection across the whole sweep with a
 * 1s gap, and the far side penalises a connection for a while after it trips — so
 * every cell inherited the previous cell's penalty and the widest cells, run last,
 * looked catastrophic. It also printed `HTTP/1.1` while pinning nothing, so the arm
 * was really h2. Re-measured with a fresh connection per run and a 30s gap, 16 wide
 * completes 16 of 16 and 32 wide 31 of 32.
 *
 * So the old numbers are deleted rather than corrected: they cannot be rescued, and
 * a plausible table is worse than none. **Two limits on the new ones too.** Most
 * cells are one to three runs, so they bound the shape and do not pin a knee. And
 * they are Node's `fetch`, which spreads width across CONNECTIONS — a browser
 * multiplexes one h2 connection to an origin, which is exactly what the limiter
 * meters, so a browser is strictly more exposed at a given width and no number here
 * is a browser number. Both are reasons to re-run before moving this, and the
 * script is honest now.
 */
export const UPLOAD_PART_CONCURRENCY = 8;

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
