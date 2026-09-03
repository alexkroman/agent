// Copyright 2026 the AAI authors. MIT license.
/**
 * How a deploy's blob writes are SCHEDULED, split from `bundle-store.test.ts`
 * (which is at the test-file line cap) because it is its own question: that file
 * asserts what the store stores, this one asserts the width at which it writes.
 */

import { sleep } from "@alexkroman1/aai/internal";
import { describe, expect, test } from "vitest";
import { createMemoryAgentRows } from "./agent-store.ts";
import { createMemoryBlobStorage } from "./blob-storage.ts";
import {
  blobKey,
  contentHash,
  createBundleStore,
  DEPLOY_BLOB_CONCURRENCY,
} from "./bundle-store.ts";
import { createMemorySecretStore } from "./secret-store.ts";

const BASE_BUNDLE = {
  slug: "test-agent",
  env: {},
  worker: "console.log('w');",
  clientFiles: {},
  credential_hashes: ["hash1"],
};

/**
 * A deploy's blob writes overlap, and the WIDTH of that overlap is ours rather
 * than the caller's.
 *
 * `DeployBodySchema` permits 100 client files, so an unbounded `Promise.all`
 * meant one deploy opened up to 102 sockets at a single Storage endpoint and two
 * concurrent deploys ~204 — a width chosen by whoever wrote the payload. That is
 * also the shape that makes `retryOnTransient` earn its keep for the wrong
 * reason: the codes it retries (`ECONNRESET`, `UND_ERR_SOCKET`) are what an
 * S3-compatible endpoint returns to a client opening far more sockets than it
 * should. Both directions are asserted, because a cap alone would pass for a
 * width of one and a fan-out alone would pass for a width of the file count.
 */
describe("a deploy's blob writes", () => {
  /** A storage whose writes wait, so overlap is observable, recording the peak. */
  function countingStorage() {
    const storage = createMemoryBlobStorage();
    const inner = storage.setItem.bind(storage);
    let inFlight = 0;
    let peak = 0;
    storage.setItem = (async (key: string, value: string) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        await sleep(2);
        await inner(key, value);
      } finally {
        inFlight -= 1;
      }
    }) as typeof storage.setItem;
    return { storage, peak: () => peak };
  }

  const manyFiles = Object.fromEntries(
    Array.from({ length: 40 }, (_, i) => [`assets/f${i}.js`, `export const n = ${i};`] as const),
  );

  test("overlap, but never more than DEPLOY_BLOB_CONCURRENCY at a time", async () => {
    const { storage, peak } = countingStorage();
    const store = createBundleStore(storage, {
      secrets: createMemorySecretStore(),
      agents: createMemoryAgentRows(),
    });

    await store.putAgent({ ...BASE_BUNDLE, clientFiles: manyFiles });

    // Really concurrent: a serial writer would peak at 1.
    expect(peak()).toBeGreaterThan(1);
    // ...and really bounded, at the declared width rather than the file count.
    expect(peak()).toBeLessThanOrEqual(DEPLOY_BLOB_CONCURRENCY);
    // Every file still landed — a bounded runner that dropped work would pass
    // both assertions above.
    for (const [path, content] of Object.entries(manyFiles)) {
      expect(await store.getClientFile(BASE_BUNDLE.slug, path)).toBe(content);
    }
  });

  test("a failed write rejects the deploy and publishes no row", async () => {
    // The property the `Promise.all` had and the pool must keep: blobs are
    // written before the row, so a write that cannot land must not leave an
    // agent whose row references a blob that is not there.
    const storage = createMemoryBlobStorage();
    const inner = storage.setItem.bind(storage);
    storage.setItem = (async (key: string, value: string) => {
      if (key === blobKey(contentHash("export const n = 7;"))) {
        throw new Error("storage is wedged");
      }
      await inner(key, value);
    }) as typeof storage.setItem;
    const store = createBundleStore(storage, {
      secrets: createMemorySecretStore(),
      agents: createMemoryAgentRows(),
    });

    await expect(store.putAgent({ ...BASE_BUNDLE, clientFiles: manyFiles })).rejects.toThrow(
      /storage is wedged/,
    );
    expect(await store.getAgent(BASE_BUNDLE.slug)).toBeNull();
  });
});
