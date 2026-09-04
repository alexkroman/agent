// Copyright 2026 the AAI authors. MIT license.
/**
 * A bounded map over a STREAM, for the two places one side of a byte pipe would
 * otherwise idle while the other works.
 *
 * `map-concurrent.ts` is the same shape over a list, and a list is what it needs:
 * it sizes its result array up front and hands slots out of a cursor. That is the
 * wrong shape for a body arriving over a socket, where the items do not exist yet
 * and pulling one is itself the expensive thing — so this pulls from an iterator
 * instead, and the bound is what stops it pulling the whole file into memory.
 *
 * ## The failure it exists to fix
 *
 * Both upload paths were a loop of the form "read a piece, await the far side,
 * repeat", and a loop of that form runs at the harmonic mean of the two links
 * rather than at the slower one. Storing a body meant reading 8 MiB off the socket
 * with the bucket idle, then writing 8 MiB to the bucket with the socket idle;
 * reading one back meant a round trip to the bucket per megabyte with the client's
 * socket idle for every one of them. Neither is bandwidth — it is one side waiting
 * out the other's latency, which is exactly what a window of in-flight work
 * removes.
 *
 * ## Results come out in SOURCE order
 *
 * Which the write path does not need and the read path cannot do without: it is
 * writing the pieces to a socket, and a chunk that overtook its predecessor would
 * be a corrupted download. Ordering costs nothing here beyond head-of-line waiting
 * inside a window that is a handful of items wide, and one primitive both callers
 * share is worth more than the last few percent to the one that could take results
 * as they land.
 *
 * ## Nothing rejects unobserved
 *
 * Every task is wrapped so it SETTLES rather than rejects, and the tag is read when
 * the task reaches the head of the window. A bare promise would be unhandled from
 * the moment it rejected until the loop got to it — which for a window of four
 * 8 MiB writes is however long the three ahead of it take, i.e. long enough for
 * Node to call it an unhandled rejection and, under the default policy, to end the
 * process. The `finally` then settles whatever is still in flight when the consumer
 * leaves early, so breaking out of the `for await` (a client that hung up
 * mid-download) cannot strand a rejection either.
 *
 * The first failure to reach the head is thrown and the source is not pulled again.
 * Tasks already in flight are NOT cancelled — this owns no signal, and the callers
 * both want the same thing anyway: an upload window that is already on its way to
 * the bucket may as well land, since re-sending it is what a retry would do.
 */

/** One task's outcome, held rather than thrown — see the module doc. */
type Settled<R> = { ok: true; value: R } | { ok: false; error: unknown };

/**
 * Map `source` through `run`, at most `width` tasks in flight, yielding in source
 * order.
 *
 * @param source - What to map. Sync or async: the read path walks a computed range
 *   list, the write path walks the body as it arrives.
 * @param width - Most tasks in flight at once. Rounded down and floored at 1, for
 *   the reason `mapConcurrent` floors its own: a zero window pulls nothing and
 *   hangs, and `Math.floor(NaN)` silently maps nothing at all.
 * @param run - Called once per item, as soon as a slot frees.
 *
 * @internal
 */
export async function* mapStream<T, R>(
  source: AsyncIterable<T> | Iterable<T>,
  width: number,
  run: (item: T, index: number) => Promise<R> | R,
): AsyncGenerator<R> {
  const size = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
  const iterator: AsyncIterator<T> | Iterator<T> =
    Symbol.asyncIterator in source ? source[Symbol.asyncIterator]() : source[Symbol.iterator]();
  const window: Promise<Settled<R>>[] = [];
  let index = 0;
  let drained = false;

  /** Start one task, holding whatever it does rather than letting it reject. */
  const begin = async (item: T, at: number): Promise<Settled<R>> => {
    try {
      return { ok: true, value: await run(item, at) };
    } catch (error: unknown) {
      return { ok: false, error };
    }
  };

  /**
   * Pull until the window is full or the source is spent.
   *
   * The pull is awaited, which is what bounds memory on the write path: the next
   * 8 MiB is read off the socket only once a slot has freed, so peak usage is the
   * window's width and not the arrival rate times however long the bucket takes.
   */
  const fill = async (): Promise<void> => {
    while (!drained && window.length < size) {
      const next = await iterator.next();
      if (next.done === true) {
        drained = true;
        return;
      }
      window.push(begin(next.value, index));
      index += 1;
    }
  };

  try {
    for (;;) {
      await fill();
      const head = window.shift();
      if (!head) return;
      const settled = await head;
      if (!settled.ok) throw settled.error;
      yield settled.value;
    }
  } finally {
    drained = true;
    // Never rejects — every entry is a `begin`, which is the whole point of the
    // wrapper. Awaited rather than abandoned so the tasks are done, not merely
    // unobserved, by the time the caller's own `finally` runs.
    await Promise.all(window);
    window.length = 0;
    await iterator.return?.(undefined);
  }
}
