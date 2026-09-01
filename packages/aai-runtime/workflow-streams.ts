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
 * ## Namespaces
 *
 * One run may write several independent channels — `report()` uses the default,
 * and a template wanting a second (a transcript beside a progress log) names
 * one. They are separate sequences with separate indices, which is why the
 * namespace is part of the key rather than a field on the chunk.
 */

/** How many chunks one namespace keeps before the oldest are dropped. */
export const STREAM_CAP = 1000;

/** The namespace a writer that names none is writing to. */
export const DEFAULT_STREAM_NAMESPACE = "default";

/** Where to read from, and which channel. */
export type StreamRead = {
  namespace?: string | undefined;
  /**
   * The index to start AFTER, or `-1` for "everything so far".
   *
   * Exclusive rather than inclusive because that is what a poller needs: it
   * holds the last index it saw and asks for what came after, where an inclusive
   * bound would re-deliver that chunk on every poll.
   */
  startIndex?: number | undefined;
};

/** One chunk and where it sits in its namespace's sequence. */
export type StreamChunk = { index: number; value: unknown };

/** The progress channel, as the engine and the run API need it. */
export type StreamStore = {
  /** Append one chunk and resolve its index. */
  write(runId: string, namespace: string, value: unknown): Promise<number>;
  /** Chunks after `startIndex`, in order. */
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

  function channelOf(runId: string, namespace: string): Channel {
    const key = `${runId} ${namespace}`;
    let channel = channels.get(key);
    if (!channel) {
      channel = { chunks: [] };
      channels.set(key, channel);
    }
    return channel;
  }

  return {
    async write(runId: string, namespace: string, value: unknown): Promise<number> {
      const channel = channelOf(runId, namespace);
      const index = (channel.chunks.at(-1)?.index ?? -1) + 1;
      channel.chunks.push({ index, value });
      if (channel.chunks.length > STREAM_CAP) channel.chunks.shift();
      return index;
    },

    async read(runId: string, options: StreamRead): Promise<StreamChunk[]> {
      const namespace = options.namespace ?? DEFAULT_STREAM_NAMESPACE;
      const after = options.startIndex ?? -1;
      return channelOf(runId, namespace).chunks.filter((chunk) => chunk.index > after);
    },

    async tail(runId: string, namespace: string): Promise<number> {
      return channelOf(runId, namespace).chunks.at(-1)?.index ?? -1;
    },
  };
}
