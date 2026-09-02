// Copyright 2026 the AAI authors. MIT license.
/**
 * Bounded-concurrency traversal of a fixed list — the one cursor-drain loop
 * behind the platform's two fan-outs: deploy blob writes in `bundle-store.ts`,
 * and queue-message DELIVERIES in `workflow-queue-sweep.ts`. (It used to name
 * the wake sweep's per-app hint reads, which went with the wake sweep.)
 *
 * **Workers pulling from a shared cursor, not a semaphore around a
 * `Promise.all`.** A semaphore's wait is BOUNDED — right for a request path,
 * where a lapsed acquire becomes a 503 somebody sees — and wrong for a
 * background fan-out, where a lapse is work silently not done: past a few
 * hundred entries everything behind the deadline is dropped on every pass. A
 * cursor has no deadline to get wrong; an entry's wait is bounded by the work
 * ahead of it, and every entry is visited.
 *
 * **Each call site keeps its own real bound where it belongs**, and neither of
 * them is a `statement_timeout` — nothing in this repository sets one, and on the
 * failure that matters (a silent partition) it could not be installed anyway; see
 * `platform-db-errors.ts`. What they actually are:
 *
 * - A DELIVERY is bounded twice over — `BROKER_READY_TIMEOUT_MS` on resolving the
 *   guest and `QUEUE_DELIVERY_TIMEOUT_MS` on the POST — and each of its `ack` /
 *   `fail` / `reschedule` statements by the admin pool's own client-side deadline
 *   (`PLATFORM_DB_QUERY_TIMEOUT_MS`). The per-message `try`/`catch` there is what
 *   keeps one unreachable guest from costing every other tenant its tick.
 * - A BLOB WRITE is bounded by nothing and needs to be: every key is a content
 *   hash and every write idempotent, so a retry re-does the set for free.
 *
 * Rejects with the FIRST failure, exactly as the `Promise.all` it replaces —
 * and does NOT cancel the rest, deliberately: every worker's promise is handed
 * to `Promise.all` up front, so a later failure is observed rather than
 * unhandled.
 *
 * @module
 */

/**
 * Run `fn` over `items` with at most `concurrency` in flight, resolving to the
 * results in ITEM order, never completion order.
 *
 * This doc used to say both call sites depend on that, and neither does today:
 * `bundle-store.ts` discards the results and the queue sweep only COUNTS its
 * outcomes. It is kept because it is free (`results[at]`, an index the worker
 * captured before its await) and because completion order is the kind of
 * nondeterminism a later caller acquires a dependency on without saying so —
 * which is exactly what the SDK's public twin, `aai/sdk/map-concurrent.ts`,
 * relies on for a workflow body's replay determinism.
 */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const drain = async (): Promise<void> => {
    // Read the entry and test IT rather than the index, so the cursor needs no
    // cast under `noUncheckedIndexedAccess`. `at` is captured before the await,
    // so each result lands at its OWN index.
    for (let at = next++, item = items[at]; item !== undefined; at = next++, item = items[at]) {
      results[at] = await fn(item, at);
    }
  };
  const workers = Math.min(Math.max(1, Math.round(concurrency)), items.length);
  await Promise.all(Array.from({ length: workers }, drain));
  return results;
}
