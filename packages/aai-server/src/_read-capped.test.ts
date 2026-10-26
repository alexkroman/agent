// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { readStreamCapped } from "./_read-capped.ts";

/** A stream of `chunks` byte arrays, counting how many the reader pulled. */
function chunked(chunks: number[]) {
  let pulled = 0;
  let cancelled = false;
  const queue = [...chunks];
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const n = queue.shift();
      if (n === undefined) {
        controller.close();
        return;
      }
      pulled += 1;
      controller.enqueue(new Uint8Array(n).fill(0x61));
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, pulled: () => pulled, cancelled: () => cancelled };
}

describe("readStreamCapped", () => {
  test("an absent body is empty, not refused", async () => {
    await expect(readStreamCapped(null, 10)).resolves.toEqual(Buffer.alloc(0));
  });

  test("returns every byte when the total is within the cap, the cap included", async () => {
    const body = chunked([4, 3, 3]);
    const read = await readStreamCapped(body.stream, 10);
    expect(read?.toString()).toBe("a".repeat(10));
  });

  test("refuses past the cap and cancels the rest unread", async () => {
    const body = chunked([6, 6, 6, 6]);
    await expect(readStreamCapped(body.stream, 10)).resolves.toBeNull();
    expect(body.pulled()).toBe(2);
    expect(body.cancelled()).toBe(true);
  });
});
