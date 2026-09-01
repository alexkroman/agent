// Copyright 2026 the AAI authors. MIT license.
/**
 * The progress channel's two non-obvious properties: an exclusive cursor, and
 * indices that survive the cap.
 */

import { describe, expect, test } from "vitest";
import { createMemoryStreams, STREAM_CAP } from "./workflow-streams.ts";

describe("reading", () => {
  test("reports -1 as the tail of a channel nothing has written to", async () => {
    // What makes a progress read TERMINATE on a run that never reported.
    const streams = createMemoryStreams();
    expect(await streams.tail("wrun_1", "default")).toBe(-1);
  });

  test("answers everything so far when asked from -1", async () => {
    const streams = createMemoryStreams();
    await streams.write("wrun_1", "default", "a");
    await streams.write("wrun_1", "default", "b");
    const chunks = await streams.read("wrun_1", { startIndex: -1 });
    expect(chunks).toEqual([
      { index: 0, value: "a" },
      { index: 1, value: "b" },
    ]);
    expect(await streams.tail("wrun_1", "default")).toBe(1);
  });

  test("treats the cursor as EXCLUSIVE, so a poller sees each chunk once", async () => {
    const streams = createMemoryStreams();
    await streams.write("wrun_1", "default", "a");
    await streams.write("wrun_1", "default", "b");
    // A poller holding index 0 asks for what came after it.
    expect(await streams.read("wrun_1", { startIndex: 0 })).toEqual([{ index: 1, value: "b" }]);
    expect(await streams.read("wrun_1", { startIndex: 1 })).toEqual([]);
  });

  test("keeps namespaces as independent sequences", async () => {
    const streams = createMemoryStreams();
    await streams.write("wrun_1", "default", "progress");
    await streams.write("wrun_1", "transcript", "words");
    expect(await streams.read("wrun_1", { namespace: "transcript" })).toEqual([
      { index: 0, value: "words" },
    ]);
    expect(await streams.tail("wrun_1", "default")).toBe(0);
  });

  test("keeps runs apart", async () => {
    const streams = createMemoryStreams();
    await streams.write("wrun_1", "default", "mine");
    expect(await streams.read("wrun_2", {})).toEqual([]);
  });
});

describe("the cap", () => {
  test("drops the oldest chunks and leaves the surviving indices unchanged", async () => {
    // The property: an index is assigned from the LAST chunk's index, never from
    // the array's length, so a cursor a reader is holding keeps meaning the same
    // thing after a drop. Deriving it from `length` would restart the sequence
    // and re-deliver the whole channel on the next poll.
    const streams = createMemoryStreams();
    for (let i = 0; i < STREAM_CAP + 5; i++) await streams.write("wrun_1", "default", i);

    expect(await streams.tail("wrun_1", "default")).toBe(STREAM_CAP + 4);
    const chunks = await streams.read("wrun_1", { startIndex: -1 });
    expect(chunks).toHaveLength(STREAM_CAP);
    // The first five are gone; the sixth kept its original index and value.
    expect(chunks[0]).toEqual({ index: 5, value: 5 });
    expect(chunks.at(-1)).toEqual({ index: STREAM_CAP + 4, value: STREAM_CAP + 4 });
  });
});
