// Copyright 2026 the AAI authors. MIT license.
/**
 * The memo both workflow stores' `create table if not exists` runs through.
 *
 * The rejection case is the one worth pinning: it is what the two hand-rolled
 * copies this replaced disagreed about, and the disagreement was invisible —
 * both spellings look correct, and only a transient DDL fault tells them apart.
 */

import { describe, expect, test, vi } from "vitest";
import { ensureOnce } from "./_ensure-once.ts";

describe("ensureOnce", () => {
  test("runs once however many callers arrive, including concurrently", async () => {
    const run = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const ensure = ensureOnce(run);

    // Concurrent first, because that is the case the promise memo exists for:
    // a boolean flipped after the await would let both of these run the DDL.
    await Promise.all([ensure(), ensure()]);
    await ensure();

    expect(run).toHaveBeenCalledTimes(1);
  });

  test("every caller sees the same settled result", async () => {
    let calls = 0;
    const ensure = ensureOnce(async () => {
      calls += 1;
    });

    await expect(ensure()).resolves.toBeUndefined();
    await expect(ensure()).resolves.toBeUndefined();
    expect(calls).toBe(1);
  });

  test("a rejection is NOT remembered as done — the next call retries", async () => {
    const run = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("permission denied for schema app_x"))
      .mockResolvedValue(undefined);
    const ensure = ensureOnce(run);

    // The failure reaches the caller rather than being swallowed: a store that
    // cannot create its table must not report success.
    await expect(ensure()).rejects.toThrow("permission denied");
    // ...and the retry is what makes a transient fault recoverable without a
    // redeploy, which is the property the keys store used to lack: it cached
    // the rejected promise, so one bad DDL broke every later read for the life
    // of the store.
    await expect(ensure()).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledTimes(2);
  });

  test("every concurrent caller of a failing run sees the failure", async () => {
    const ensure = ensureOnce(() => Promise.reject(new Error("boom")));
    const [a, b] = await Promise.allSettled([ensure(), ensure()]);

    expect(a?.status).toBe("rejected");
    expect(b?.status).toBe("rejected");
  });

  test("a synchronous throw is routed through the same clearing path", async () => {
    // `run` is called inside the async wrapper, so a body that throws before
    // its first await must still clear the memo rather than escape uncached.
    const run = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => {
        throw new Error("sync");
      })
      .mockResolvedValue(undefined);
    const ensure = ensureOnce(run);

    await expect(ensure()).rejects.toThrow("sync");
    await expect(ensure()).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledTimes(2);
  });
});
