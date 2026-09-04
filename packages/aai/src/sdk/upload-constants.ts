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
 * **8 MiB, and the reason it sat here has now been REMOVED — so this number is due a
 * re-measurement.** On the direct path (a deployed agent — see
 * `_upload-blobs-brokered.ts`) a part used to be two serialized requests: the window
 * to the platform, then a body-less `PUT …/parts?offset=…&stored=1` telling the agent
 * it landed. Measured against a deployed agent, per 4 MiB part:
 *
 * | | time | rate |
 * | --- | --- | --- |
 * | byte `PUT` to the platform | 926-2121 ms | 1.9-4.3 MB/s |
 * | `stored=1` claim, brokered to the guest | 1604-1969 ms | no body at all |
 *
 * Roughly half a part's wall time was a round trip carrying nothing, paid per PART
 * rather than per byte — so a bigger window was attractive mostly because it
 * amortized a fixed cost, and halving this constant doubled how many times that cost
 * was paid. That is what `UPLOAD_CLAIM_BATCH` took away: a claim now names
 * every window that has landed since the last one, so the toll is per-BATCH.
 *
 * **This reverses a first attempt at 4 MiB**, which reasoned that a smaller window
 * makes a reset cheaper (true, and measured: at four wide, 8 MiB bodies reset where
 * 4 MiB, 2 MiB and 1 MiB passed). That was the right trade only if the part's cost is
 * mostly its bytes — which it was not, and which batching now makes it much closer to
 * being. Both directions are open again on evidence rather than on this paragraph.
 *
 * **16 MiB is SLOWER, measured after the claims were batched.** 128 MiB file, width
 * 8, three runs per cell, alternating order so a drifting link cannot favour one,
 * pinned HTTP/1.1 on a fresh connection with 30s between runs:
 *
 * | part | wall p50 | range | MB/s | windows per claim | part re-sent |
 * | --- | --- | --- | --- | --- | --- |
 * | 8 MiB | **23.2s** | 19.3-29.0s | **5.5** | 16 in 3-5 | 0 of 3 runs |
 * | 16 MiB | 28.2s | 24.4-30.0s | 4.5 | 8 in 4-5 | **2 of 3 runs** |
 *
 * **Read that as "16 MiB is not better", not as "8 MiB is faster."** The ranges
 * overlap heavily — 8 MiB's worst run (29.0s) is slower than 16 MiB's median — and
 * three runs bound a shape rather than pin a knee. The re-sent parts are the firmer
 * half: 0 of 3 against 2 of 3 is about a limit being approached rather than about
 * which median won, and 8 x 16 MiB is 128 MiB in flight — the same row the reset
 * shoulder appears on below.
 *
 * **A pre-batching table here reported 16 MiB ~28% FASTER per byte, and it is
 * DELETED rather than corrected.** It was measuring the fixed per-part claim being
 * amortized over more bytes — so it was a fact about the round trip, not about the
 * part size, and nothing in it can be rescued now the round trip is batched. Same
 * rule, and the same reason, as the contaminated h2 table under
 * `UPLOAD_PART_CONCURRENCY`: a plausible table is worse than none, because it
 * is the thing a later reader reaches for instead of measuring.
 *
 * Three costs land on the PRODUCT of this and `UPLOAD_PART_CONCURRENCY` rather than
 * on the size alone, and they are why a future re-measurement that flatters 16 MiB
 * still would not settle it on its own:
 *
 * - **Platform memory.** `_upload-blobs-http.ts` buffers a whole window to hand
 *   Storage a length — unavoidable, and the reason the cap is a window rather than a
 *   file. At eight wide, 16 MiB parts ask a shared memory-bounded process to hold
 *   128 MiB for ONE upload.
 * - **The reset shoulder.** 128 MiB in flight is the row where a reset appeared
 *   (31 of 32); 64 MiB, which eight 8 MiB parts hold, did not.
 * - **The parallelism FLOOR.** `partsPlan` declines a plan of fewer than two parts,
 *   so this constant sets the size below which `upload()` takes the single request
 *   and gets no retry at all: 16 MB at 8 MiB, 32 MB at 16 MiB, a regression for every
 *   recording in between. Note this bounds the SPEED path only — a caller-named
 *   upload passes `resumable`, which re-cuts at {@link UPLOAD_CHUNK_BYTES} precisely
 *   so a small file still has windows to resume from.
 *
 * None of the three moved with batching, which is why they still decide this: two are
 * properties of a window's size against a memory-bounded process, and the third is a
 * property of the plan. The claim was the only cost batching could reach.
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
 * **Eight, doubled from four.** It was doubled because every part on the direct path
 * cost a fixed ~1.7s body-less round trip to the guest on top of its bytes
 * ({@link UPLOAD_PART_BYTES} carries the table): a per-part toll independent of size,
 * whose only concealment is OVERLAP — which is what this number is. Extrapolated over
 * a 660 MB recording at the time: ~77s at four wide against ~38s at eight.
 *
 * **That argument is now mostly spent, and the number stays anyway.**
 * `UPLOAD_CLAIM_BATCH` removed the per-part toll, so width no longer has a
 * round trip to hide; what it still buys is bytes in flight, and the three reasons
 * below say why more of those is not worth having. Eight is therefore held by the
 * reset shoulder rather than by the claim — a different argument for the same value,
 * which is worth stating because the OLD one would have justified going wider and
 * this one does not.
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
 * How many landed offsets one claim may name.
 *
 * **The batch that removes the toll {@link UPLOAD_PART_BYTES} spent a page arguing
 * around.** On the direct path a part used to be two serialized requests — the
 * window to the platform, then a body-less `PUT …/parts?offset=…&stored=1` telling
 * the agent it landed — and the second one measured 1604-1969 ms against a deployed
 * agent, roughly half of a part's wall time, carrying nothing. It was paid per PART,
 * so it set the floor under every other number here: it is why a bigger window
 * measured faster (it amortizes a fixed cost), and why eight parts in flight beat
 * four (overlap was the only thing hiding it).
 *
 * A claim now names every window that has landed since the last one went out, so N
 * parts cost far fewer than N claims — and the guest's side collapses with it, from
 * N lock acquisitions and N whole-array record writes to one of each per request.
 * Measured against a deployed agent: a 128 MiB file in 8 MiB windows recorded its
 * **16 parts in 3 to 5 claims**. The batch sizes ITSELF rather than being tuned —
 * one claim is in flight at a time and everything landing during it coalesces into
 * the next — so the ratio is whatever the link and the round trip make it.
 *
 * The cap is what a single request may ask for, and it bounds three things at once:
 * the guest's concurrent `size` probes, the size of the merged write under the
 * record lock, and what one hostile caller can make one request do. Thirty-two is
 * four times the default width, so the client's own accumulation never reaches it
 * and the number is a ceiling rather than a divisor.
 *
 * **A client may only batch when the agent SAID SO** — `UploadCreated.claimBatch`,
 * decided by the claim exactly as `directParts` is. Guessing is the one thing that
 * cannot be allowed here: an agent that reads a single `?offset=` would record the
 * first window, answer 200, and leave the rest as holes that read as silence, which
 * is the failure `recordParts` asks the bucket about every window to prevent.
 */
export const UPLOAD_CLAIM_BATCH = 32;

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
 * How many times an upload is RE-ENTERED — claim, ranges, send what is missing —
 * before it gives up.
 *
 * The retry budget above is per REQUEST and is sized for the failure a fan-out
 * meets while the agent is up: a reset stream, a 503 from a guest at capacity.
 * Four attempts spanning ~4-11s cover that and nothing longer, and the thing
 * they cannot cover is the ordinary event this platform is built out of — **the
 * agent going away and coming back**. A Modal sandbox is superseded on redeploy
 * and reclaimed on idle, `aai dev` restarts on every file save, and a managed
 * Postgres fails over; each of those is tens of seconds during which every
 * request fails, so the whole fan-out spent its budget inside the outage and a
 * 660 MB recording that was 90% stored was thrown away entirely.
 *
 * A re-entry is not a retry of a request. It re-reads `UploadInfo.ranges` and
 * sends only the windows that are missing, so the second round of a nearly
 * finished upload is nearly free — which is what makes a budget this long
 * affordable, and what makes the whole file the thing being protected rather
 * than one window of it.
 *
 * Four rounds at {@link UPLOAD_RESUME_BASE_MS} doubling is ~30s of waiting, plus
 * each round's own request budget: roughly a minute of downtime survived, which
 * is a redeploy with room to spare. Past that the person is better told.
 */
export const UPLOAD_RESUME_ATTEMPTS = 4;

/**
 * The first wait before an upload is re-entered, doubling from there.
 *
 * Two seconds rather than the half-second a request waits, because what is being
 * waited out is a PROCESS rather than a queue: the round that just failed already
 * spent seconds establishing that nothing is answering, and a sandbox that is
 * booting cannot answer sooner than it boots. Asking again in 500ms only spends
 * the budget faster.
 */
export const UPLOAD_RESUME_BASE_MS = 2000;

/**
 * The longest wait between re-entries.
 *
 * Fifteen seconds is past the point where a person watching a stalled bar wants
 * to be told rather than waited for — and unlike the per-request cap, this one is
 * not competing with a `Retry-After`: nothing answered, so there is no far side
 * with an opinion.
 */
export const UPLOAD_RESUME_MAX_MS = 15_000;

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
