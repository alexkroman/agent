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
 * is the shape the DevKit's streams had and for the same reason, and its own
 * adapter doc called the tail "not optional", which it is not.
 *
 * ## `startIndex` is SIGNED, and that is the DevKit's semantics on purpose
 *
 * A non-negative value is an exclusive FLOOR — a cursor a reader has already
 * read past — and a negative one counts back from the END, so `-1` is the last
 * chunk alone. Both readings are load-bearing and belong to callers this module
 * does not own: `workflow-api-stream.ts` polls with the last index it saw, and
 * `WorkflowClient.lastLine` asks for `-1`.
 *
 * The first draft implemented the floor only, so `-1` meant "everything after
 * index -1" — everything. `lastLine` then took the FIRST chunk of the log and
 * returned it as the newest line, which is the exact thing that method exists to
 * avoid; the client's own comment ("the alternative replays the whole log to
 * throw all but its final entry away") described what it had started doing.
 * Nothing caught it, because `workflow-client.test.ts`'s fake implements
 * `written.slice(startIndex ?? 0)` — laxer than the interface, which is the
 * hazard `workflow-journal-types.ts` warns about in its own doc.
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
 * The drop is a `splice` of a block rather than a `shift` per write, because
 * `shift` is an O(n) memmove of the whole ring and `write` is on the narration
 * path of every step of every run — a 60-segment fan-out narrating per segment
 * pays it per line. Amortized this way it is one memmove per 100 writes.
 */
const STREAM_SLACK = 100;

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
   * A SIGNED cursor — see this module's doc, which carries the bug the unsigned
   * reading caused.
   *
   * - **`undefined`** — every chunk still held.
   * - **`>= 0`** — an exclusive floor: what came AFTER this index. Exclusive
   *   because that is what a poller needs, holding the last index it saw; an
   *   inclusive bound would re-deliver that chunk on every poll.
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
      // A floor. `slice` rather than `filter`, which is what makes `lastLine`
      // cheap: indices within a channel are contiguous (`write` assigns
      // `last + 1`, and the cap only ever drops from the front), so the position
      // of a cursor is arithmetic rather than a scan. Clamped at zero for a
      // cursor from before a drop, whose chunks are simply gone.
      const first = chunks[0];
      if (!first) return [];
      return chunks.slice(Math.max(0, from - first.index + 1));
    },

    async tail(runId: string, namespace: string): Promise<number> {
      return existing(runId, namespace).at(-1)?.index ?? -1;
    },
  };
}
