// Copyright 2026 the AAI authors. MIT license.
/**
 * Serialize stream writes behind a promise chain.
 *
 * One implementation for the two ends of the NDJSON pipe: the host transport
 * (`ndjson-transport.ts`, chaining behind Node stream backpressure) and the
 * Deno guest harness (`harness-rpc.ts`, looping partial `Deno.stdout.write`s).
 * Each used to hand-roll the same pattern with its own dead-peer latch. It
 * lives under `guest/` rather than a shared host module because the harness
 * is bundled into a self-contained artifact with ZERO workspace imports —
 * sibling guest modules are the one thing it may import — while the host can
 * import from here freely.
 *
 * Semantics both sides rely on:
 *
 * - **Ordering**: writes run strictly in enqueue order, so line framing
 *   never tears.
 * - **Synchronous fast path**: with an idle chain, a `write` that accepts
 *   its payload outright (returns `undefined`) chains nothing — the common
 *   no-backpressure case stays synchronous.
 * - **The chain never rejects**: a failing write routes to `onError` (dead
 *   peer latching, logging) and later writes still run — one bad write must
 *   not wedge the serializer or become an unhandled rejection.
 * - **Identity reset**: the last pending link returns the chain to the fast
 *   path, checked by identity so a link finishing behind a newer one can't
 *   clear the newer one's tail.
 */
export interface WriteChain {
  /**
   * Queue `write` behind all pending writes. The returned promise settles
   * once this write has flushed (or failed into `onError`); it never
   * rejects.
   */
  enqueue(write: () => Promise<void> | undefined): Promise<void>;
}

/** Create a {@link WriteChain}. `onError` must not throw (best-effort logging). */
export function createWriteChain(onError: (err: unknown) => void = () => undefined): WriteChain {
  let chain: Promise<void> | null = null;
  return {
    enqueue(write: () => Promise<void> | undefined): Promise<void> {
      const wait = chain === null ? write() : chain.then(write);
      if (wait === undefined) return Promise.resolve();
      const link: Promise<void> = wait
        .catch((err: unknown) => {
          try {
            onError(err);
          } catch {
            // A throwing error handler must not poison the chain.
          }
        })
        .then(() => {
          if (chain === link) chain = null;
        });
      chain = link;
      return link;
    },
  };
}
