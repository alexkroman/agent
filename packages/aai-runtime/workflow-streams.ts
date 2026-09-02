// Copyright 2026 the AAI authors. MIT license.
/**
 * A run's PROGRESS channel: what `report()` writes and a page reads back.
 *
 * Separate from `JournalStore` although both are per-run durable state, because
 * the two have opposite properties and merging them would give the stricter one
 * away. A journal entry is a fact the engine's correctness depends on: it must
 * survive, and it is read on every replay. A progress chunk is a courtesy to
 * whoever is watching, so losing one costs a line in a UI and no replay reads
 * it. This can therefore be lossy and capped where the journal cannot, and is.
 *
 * ## Chunks are INDEXED, and the tail is what makes a read terminate
 *
 * A progress channel is written by one step after another and is never CLOSED —
 * there is no point at which a step knows it is the last. A reader waiting for
 * the end therefore waits forever, even on a completed run. So a read is bounded
 * by {@link StreamStore.tail}: the index of the last chunk written so far. That
 * is the shape the DevKit's streams had and for the same reason — the tail is
 * not optional.
 *
 * ## `startIndex` is SIGNED, and both readings have a caller
 *
 * A non-negative value is an INCLUSIVE floor — the first index the reader wants
 * — and a negative one counts back from the END, so `-1` is the last chunk
 * alone. Both readings are load-bearing and belong to callers this module does
 * not own: `workflow-api-stream.ts` polls with the first index it has NOT seen,
 * and `WorkflowClient.lastLine` asks for `-1`.
 *
 * The first draft implemented the floor only, so `-1` meant "everything from
 * index -1" — everything. `lastLine` then took the FIRST chunk of the log and
 * returned it as the newest line, which is the exact thing that method exists to
 * avoid; the client's own comment ("the alternative replays the whole log to
 * throw all but its final entry away") described what it had started doing.
 * Nothing caught it, because `workflow-client.test.ts`'s fake implements
 * `written.slice(startIndex ?? 0)`.
 *
 * ## The floor is INCLUSIVE, and it was EXCLUSIVE here alone
 *
 * The second draft made the non-negative reading exclusive — "a cursor a reader
 * has already read past" — on the argument that an inclusive bound re-delivers
 * the cursor's own chunk on every poll. That argument is about a cursor holding
 * the LAST INDEX SEEN, and no caller in this repository holds one. Every consumer
 * counts what it consumed and re-sends that count, which IS the first unread
 * index: `followRunOutput` does `next += 1` per chunk, `useWorkflowProgress` does
 * `next += chunks.length`, `budgetFor` computes `tail + 1 - startIndex`, and
 * `lastLine` refuses when `tail < startIndex`. So this store answered
 * `read({ startIndex: 0 })` with everything EXCEPT chunk 0 while five callers
 * asked it for everything — a default `followRunOutput` never yielded a run's
 * first progress line, permanently, and `useWorkflowProgress` lost the chunk at
 * its cursor on every re-open.
 *
 * The deciding argument is not the count of callers, it is that an exclusive
 * floor has NO SPELLING for "I have seen nothing" on a signed parameter: the
 * cursor before chunk 0 is -1, and -1 already means "the last chunk alone". So
 * exclusive forces every caller to special-case its own origin into an absent
 * parameter — two spellings for one cursor, and an off-by-one at the boundary
 * between them, which is exactly the defect that shipped. Inclusive needs one
 * spelling, and `undefined` then means the same thing as `0` rather than
 * something a caller has to know is different.
 *
 * `workflow-stream-cursor.test.ts` is the oracle over the whole chain; it is
 * where a third draft has to argue with a property rather than with this
 * paragraph.
 *
 * ## Namespaces
 *
 * One run may write several independent channels — `report()` uses the default,
 * and a template wanting a second (a transcript beside a progress log) names
 * one. They are separate sequences with separate indices, which is why the
 * namespace is part of the key rather than a field on the chunk.
 */

/** How many chunks one namespace keeps before the oldest are dropped. */
export const STREAM_CAP = 1000;

/**
 * Slack above {@link STREAM_CAP} before the oldest chunks are dropped.
 *
 * Exported for `workflow-stream-cursor.test.ts`'s model of the retained window,
 * which computes the same window in closed form rather than by simulating the
 * loop below. Sharing the two CONSTANTS is what keeps that model honest when a
 * cap moves; sharing the arithmetic would make it agree with a bug.
 *
 * @internal
 *
 * The drop is a `splice` of a block rather than a `shift` per write, because
 * `shift` is an O(n) memmove of the whole ring and `write` is on the narration
 * path of every step of every run — a 60-segment fan-out narrating per segment
 * pays it per line. Amortized this way it is one memmove per 100 writes.
 */
export const STREAM_SLACK = 100;

/** The namespace a writer that names none is writing to. */
export const DEFAULT_STREAM_NAMESPACE = "default";

/**
 * The channel a caller means, from whatever they passed.
 *
 * ONE owner, because there were four and they disagreed. An absent namespace and
 * an EMPTY one are the same request — `?namespace=` on a query string parses to
 * `""`, and answering that with a channel nobody writes to is an empty progress
 * log with nothing saying why — so a `??` in one place and a `||` in another put
 * a writer and a reader in different channels for the same URL.
 *
 * @internal
 */
export function streamNamespace(namespace: string | undefined): string {
  const named = namespace?.trim();
  return named ? named : DEFAULT_STREAM_NAMESPACE;
}

/** Where to read from, and which channel. */
export type StreamRead = {
  namespace?: string | undefined;
  /**
   * A SIGNED cursor — see this module's doc, which carries both bugs the two
   * wrong readings caused.
   *
   * - **`undefined`** — every chunk still held. The same answer as `0`, which is
   *   what makes an absent parameter safe for a reader that has seen nothing.
   * - **`>= 0`** — an INCLUSIVE floor: this index and everything after it. A
   *   poller holds the first index it has NOT seen and sends exactly that, so
   *   nothing is re-delivered and nothing is skipped.
   * - **`< 0`** — the last `|startIndex|` chunks, so `-1` is the newest alone.
   */
  startIndex?: number | undefined;
};

/** One chunk and where it sits in its namespace's sequence. */
export type StreamChunk = { index: number; value: unknown };

/** The progress channel, as the engine and the run API need it. */
export type StreamStore = {
  /** Append one chunk and resolve its index. */
  write(runId: string, namespace: string, value: unknown): Promise<number>;
  /** The chunks `options` selects — see {@link StreamRead.startIndex}. */
  read(runId: string, options: StreamRead): Promise<StreamChunk[]>;
  /** The last index written, or `-1` when nothing has been. */
  tail(runId: string, namespace: string): Promise<number>;
};

/** One namespace's ring: the chunks it still holds. */
type Channel = { chunks: StreamChunk[] };

/**
 * A {@link StreamStore} in memory, capped per namespace.
 *
 * The cap is what makes it safe to leave running: a workflow reporting once a
 * second for a day is 86,400 chunks and nothing else drops them. The OLDEST is
 * the right end to lose, a reader being at the head, and the indices stay honest
 * because they come from the last chunk's index rather than from the array's
 * length — so a cursor a reader is holding keeps meaning the same thing after a
 * drop.
 *
 * @internal
 */
export function createMemoryStreams(): StreamStore {
  const channels = new Map<string, Channel>();

  const keyOf = (runId: string, namespace: string) => `${runId} ${namespace}`;

  /**
   * The channel a READ means, without creating one.
   *
   * Reads must not mint channels: `GET /workflows/runs/:id/stream` is a public
   * route and its `namespace` is request input, so a get-or-create here grows
   * the map by one permanent empty entry per (run, namespace) ever ASKED ABOUT —
   * driven by readers rather than by runs, and by strangers rather than by work.
   */
  function existing(runId: string, namespace: string): readonly StreamChunk[] {
    return channels.get(keyOf(runId, namespace))?.chunks ?? [];
  }

  return {
    async write(runId: string, namespace: string, value: unknown): Promise<number> {
      const key = keyOf(runId, namespace);
      let channel = channels.get(key);
      if (!channel) {
        channel = { chunks: [] };
        channels.set(key, channel);
      }
      const index = (channel.chunks.at(-1)?.index ?? -1) + 1;
      channel.chunks.push({ index, value });
      if (channel.chunks.length > STREAM_CAP + STREAM_SLACK) {
        channel.chunks.splice(0, channel.chunks.length - STREAM_CAP);
      }
      return index;
    },

    async read(runId: string, options: StreamRead): Promise<StreamChunk[]> {
      const chunks = existing(runId, streamNamespace(options.namespace));
      const from = options.startIndex;
      if (from === undefined) return [...chunks];
      // From the end, so `-1` is the newest chunk alone.
      if (from < 0) return chunks.slice(from);
      // An INCLUSIVE floor. `slice` rather than `filter`, which is what makes
      // `lastLine` cheap: indices within a channel are contiguous (`write`
      // assigns `last + 1`, and the cap only ever drops from the front), so the
      // position of a cursor is arithmetic rather than a scan. Clamped at zero
      // for a cursor from before a drop, whose chunks are simply gone.
      const first = chunks[0];
      if (!first) return [];
      return chunks.slice(Math.max(0, from - first.index));
    },

    async tail(runId: string, namespace: string): Promise<number> {
      return existing(runId, namespace).at(-1)?.index ?? -1;
    },
  };
}
