// Copyright 2026 the AAI authors. MIT license.
/**
 * How the Postgres backend GROUPS a body's chunks into one write.
 *
 * Its own module rather than lines in `_upload-store-postgres.ts` for the line cap,
 * and local to that backend for the reason its predecessor gave: the file store
 * writes into a descriptor, so it has no round trip to amortize and grouping there
 * would only add latency.
 *
 * Two numbers, and they answer opposite failures — read
 * {@link UPLOAD_WRITE_BATCH_CHUNKS} for why grouping pays, and
 * {@link UPLOAD_WRITE_BATCH_MS} for why it must not become a wait.
 */

import pTimeout from "p-timeout";
import { chunkSeq } from "./_upload-store.ts";

/**
 * How many chunks one statement commits.
 *
 * A chunk used to be one awaited `INSERT` per `UPLOAD_CHUNK_BYTES`, and that shape
 * has two costs a batch removes, both measured in production:
 *
 * - **The body drains at the speed of a round trip per megabyte.** The loop awaits
 *   a commit before pulling the next chunk off the request, so the socket moves
 *   only as fast as this app's Postgres — which for a deployed agent is a pooler in
 *   another AWS region. The platform's forward measures exactly that drain to
 *   decide whether a guest is alive, so a part that is storing perfectly well looks
 *   like a stall: 6 upload `PUT`s answered 503 or 408 in one hour, three of them
 *   aborted at 121-125s against a 120s window that had just been raised from 30s.
 * - **It holds a pool connection for the whole part.** `postgres-db.ts` pools four
 *   by default and the whole guest shares it — the workflow engine's polling, every
 *   `/stream` re-read, session state — so the client's four concurrent parts take
 *   the pool for the length of the upload. Measured over the same hour: every
 *   non-upload request on that agent ran at **p50 1.34s while a part was in flight
 *   against 0.43s when none was**, a 3.1x slowdown across 801 and 366 samples, with
 *   `GET /workflows/runs` peaking at 17.7s.
 *
 * FOUR rather than the whole part, because the app role carries
 * `statement_timeout = '10s'` (`aai-server/app-database.ts`) and one statement has
 * to stay well inside it. Four cuts an 8 MiB part from eight round trips to two and
 * bounds the extra memory at 4 MiB per part in flight, where buffering the part
 * whole would be bounded only by the upload's own declared total — 2 GiB.
 */
export const UPLOAD_WRITE_BATCH_CHUNKS = 4;

/**
 * The longest a chunk waits for company before it is written anyway.
 *
 * Grouping is only ever an answer to a BACKLOG, and without this bound it would
 * also be a delay imposed on a body that has none. That matters most on the
 * STREAMED write, which publishes `size` per batch — the number a run polls to
 * learn how far it may read, and the number an abandonment bound is judged
 * against — so a slow uplink delivering a megabyte every few seconds would have
 * its bytes held until a fourth arrived and `size` would stop advancing on exactly
 * the links where it matters most. With the bound, a chunk that arrives alone is
 * written alone, and grouping engages only when chunks are queueing up behind the
 * write, which is the case the measurements above describe.
 *
 * 250ms is under a poll interval by an order of magnitude, so it is invisible to
 * every reader, and far above a round trip, so a busy upload still fills a batch.
 */
export const UPLOAD_WRITE_BATCH_MS = 250;

/** A chunk and the absolute byte it goes at — what a backend writes and publishes from. */
export type PlacedChunk = { bytes: Uint8Array; at: number };

/** One chunk row, ready to be a tuple in a batched insert. */
export type ChunkRow = PlacedChunk & { seq: number };

/**
 * `chunked`'s pieces, each carrying the offset it goes at.
 *
 * `partChunks` already yields this shape (its offsets start at the part's own), so
 * this is the adapter that lets the whole-file writers share one grouping loop with
 * the parts writer.
 */
export async function* placed(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<PlacedChunk> {
  let at = 0;
  for await (const bytes of chunks) {
    yield { bytes, at };
    at += bytes.length;
  }
}

/** Nothing more arrived in time — write what is held. */
const HELD = Symbol("held");

/**
 * The next chunk, or {@link HELD} once a waiting batch has waited long enough.
 *
 * `held` is false for an EMPTY batch, which is holding nothing up — arming a timer
 * per idle poll of a body that may be minutes from its next byte is a timer per
 * nothing.
 */
async function nextChunk(
  pending: Promise<IteratorResult<PlacedChunk>>,
  held: boolean,
): Promise<IteratorResult<PlacedChunk> | typeof HELD> {
  if (!held) return await pending;
  return await pTimeout(pending, {
    milliseconds: UPLOAD_WRITE_BATCH_MS,
    fallback: (): typeof HELD => HELD,
  });
}

/**
 * Placed chunks, grouped into one write's worth.
 *
 * Bounded by {@link UPLOAD_WRITE_BATCH_CHUNKS} and by {@link UPLOAD_WRITE_BATCH_MS}:
 * the batch is what is ALREADY THERE, never a wait imposed on a body that is
 * arriving slowly.
 *
 * `seq` is derived from the offset rather than counted, which is what makes one loop
 * serve all three writers: `chunked` yields whole `UPLOAD_CHUNK_BYTES` pieces so a
 * whole-file write's counter and `chunkSeq` agree by construction, and a part has no
 * counter to agree with — its seq IS a function of where it lands.
 */
export async function* inBatches(chunks: AsyncIterable<PlacedChunk>): AsyncGenerator<ChunkRow[]> {
  const source = chunks[Symbol.asyncIterator]();
  let batch: ChunkRow[] = [];
  // Held ACROSS iterations: a timed-out `next()` is still the pending read of the
  // next chunk, and asking for another would drop the one already in flight.
  let pending: Promise<IteratorResult<PlacedChunk>> | undefined;
  try {
    for (;;) {
      pending ??= source.next();
      let step: IteratorResult<PlacedChunk> | typeof HELD;
      try {
        step = await nextChunk(pending, batch.length > 0);
      } catch (err: unknown) {
        // The body died holding bytes that had already ARRIVED, and those are
        // exactly the ones a streamed upload promises to keep: an interrupted
        // stream stays incomplete and readable rather than being deleted, because
        // a reader may already have used the part that landed. Written first, then
        // the failure — so grouping costs a torn upload nothing it used to keep.
        if (batch.length > 0) yield batch;
        throw err;
      }
      if (step === HELD) {
        yield batch;
        batch = [];
        continue;
      }
      pending = undefined;
      if (step.done) break;
      batch.push({ ...step.value, seq: chunkSeq(step.value.at) });
      if (batch.length >= UPLOAD_WRITE_BATCH_CHUNKS) {
        yield batch;
        batch = [];
      }
    }
    if (batch.length > 0) yield batch;
  } finally {
    // A consumer that stopped early (a write that threw) leaves the body half-read
    // and possibly one read in flight — the same close a `for await` would have
    // done, plus a handler for the read nobody is going to await.
    pending?.catch(() => undefined);
    await source.return?.();
  }
}

/** The byte one batch ends at — the `size` a whole-file writer has stored so far. */
export function batchEnd(batch: readonly PlacedChunk[]): number {
  const last = batch.at(-1);
  return last ? last.at + last.bytes.length : 0;
}
