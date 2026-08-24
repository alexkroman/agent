// Copyright 2026 the AAI authors. MIT license.
/**
 * Bounded-concurrency traversal of a fixed list — the one cursor-drain loop
 * behind the platform's two fan-outs (deploy blob writes in `bundle-store.ts`,
 * per-app wake-hint reads in `_workflow-wake-read.ts`).
 *
 * **Workers pulling from a shared cursor, not a semaphore around a
 * `Promise.all`.** A semaphore's wait is BOUNDED — right for a request path,
 * where a lapsed acquire becomes a 503 somebody sees — and wrong for a
 * background fan-out, where a lapse is work silently not done: past a few
 * hundred entries everything behind the deadline is dropped on every pass. A
 * cursor has no deadline to get wrong; an entry's wait is bounded by the work
 * ahead of it, and every entry is visited. Each call site keeps its own real
 * bound where it belongs (a `statement_timeout` inside the read, the
 * idempotence of a content-addressed write).
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
 * results in ITEM order (never completion order — both call sites depend on
 * the input ordering surviving).
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
