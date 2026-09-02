// Copyright 2026 the AAI authors. MIT license.
/**
 * The progress channel's two non-obvious properties: an exclusive cursor, and
 * indices that survive the cap.
 */

import { describe, expect, test } from "vitest";
import { createMemoryStreams, DEFAULT_STREAM_NAMESPACE, STREAM_CAP } from "./workflow-streams.ts";

describe("reading", () => {
  test("reports -1 as the tail of a channel nothing has written to", async () => {
    // What makes a progress read TERMINATE on a run that never reported.
    const streams = createMemoryStreams();
    expect(await streams.tail("wrun_1", "default")).toBe(-1);
  });

  test("answers everything so far when asked with no cursor", async () => {
    const streams = createMemoryStreams();
    await streams.write("wrun_1", "default", "a");
    await streams.write("wrun_1", "default", "b");
    expect(await streams.read("wrun_1", {})).toEqual([
      { index: 0, value: "a" },
      { index: 1, value: "b" },
    ]);
    expect(await streams.tail("wrun_1", "default")).toBe(1);
  });

  test("treats the cursor as INCLUSIVE, so a poller sees each chunk once", async () => {
    const streams = createMemoryStreams();
    await streams.write("wrun_1", "default", "a");
    await streams.write("wrun_1", "default", "b");
    // A poller sends the first index it has NOT seen, so a reader that has read
    // nothing sends 0 and receives the whole log — the case this used to lose.
    expect(await streams.read("wrun_1", { startIndex: 0 })).toEqual([
      { index: 0, value: "a" },
      { index: 1, value: "b" },
    ]);
    expect(await streams.read("wrun_1", { startIndex: 1 })).toEqual([{ index: 1, value: "b" }]);
    // Caught up: the cursor names a chunk the run has not written.
    expect(await streams.read("wrun_1", { startIndex: 2 })).toEqual([]);
  });

  test("an absent cursor and a zero are the SAME request", async () => {
    // The property that lets every consumer send its count unconditionally. Read
    // exclusively these two disagreed, and the only spelling for "I have seen
    // nothing" was the absent one — see this module's doc for why that boundary
    // is where the off-by-one lived.
    const streams = createMemoryStreams();
    for (const line of ["a", "b", "c"]) await streams.write("wrun_1", "default", line);
    expect(await streams.read("wrun_1", { startIndex: 0 })).toEqual(
      await streams.read("wrun_1", {}),
    );
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
    //
    // Enough writes to cross the cap AND the slack, because the drop is
    // amortized — a block `splice` once per `STREAM_SLACK` writes rather than a
    // `shift` per write, which is an O(n) memmove of the whole ring.
    const streams = createMemoryStreams();
    const written = STREAM_CAP + 250;
    for (let i = 0; i < written; i++) await streams.write("wrun_1", "default", i);

    // The tail is the true sequence position, whatever was dropped.
    expect(await streams.tail("wrun_1", "default")).toBe(written - 1);

    const chunks = await streams.read("wrun_1", {});
    // Held between the cap and the cap plus one slack window.
    expect(chunks.length).toBeGreaterThanOrEqual(STREAM_CAP);
    expect(chunks.length).toBeLessThanOrEqual(STREAM_CAP + 100);
    // Whatever survived kept its ORIGINAL index and value — the pair is what a
    // reader's cursor is compared against.
    const first = chunks[0];
    expect(first?.index).toBe(first?.value);
    expect(chunks.at(-1)).toEqual({ index: written - 1, value: written - 1 });
  });
});

describe("the signed cursor", () => {
  test("answers the NEWEST chunk alone for -1, which is what `lastLine` asks", async () => {
    // The bug this pins: the first draft read `-1` as "everything after index
    // -1", so `lastLine` took the FIRST chunk of the log and returned it as the
    // newest line — the exact thing that method exists to avoid.
    const streams = createMemoryStreams();
    for (const line of ["oldest", "middle", "newest"]) {
      await streams.write("wrun_1", "default", line);
    }
    expect(await streams.read("wrun_1", { startIndex: -1 })).toEqual([
      { index: 2, value: "newest" },
    ]);
  });

  test("answers the last N for -N", async () => {
    const streams = createMemoryStreams();
    for (const line of ["a", "b", "c"]) await streams.write("wrun_1", "default", line);
    expect((await streams.read("wrun_1", { startIndex: -2 })).map((c) => c.value)).toEqual([
      "b",
      "c",
    ]);
  });

  test("answers everything for an ABSENT cursor, which is now how you ask", async () => {
    const streams = createMemoryStreams();
    for (const line of ["a", "b"]) await streams.write("wrun_1", "default", line);
    expect(await streams.read("wrun_1", {})).toHaveLength(2);
  });

  test("answers a cursor from before a drop with what survives, not from the end", async () => {
    // The clamp. Without it the arithmetic goes negative and `slice` reads it as
    // count-back-from-the-end — so a stale poller would be handed the newest
    // chunks as if they were the ones after its cursor.
    const streams = createMemoryStreams();
    for (let i = 0; i < STREAM_CAP + 200; i++) await streams.write("wrun_1", "default", i);
    const chunks = await streams.read("wrun_1", { startIndex: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]?.index).toBeGreaterThan(0);
  });
});

describe("reads never mint a channel", () => {
  test("an unknown run reads empty and leaves nothing behind", async () => {
    // `GET /workflows/runs/:id/stream` is public and its `namespace` is request
    // input, so a get-or-create on the read path grows the map by one permanent
    // entry per (run, namespace) ever ASKED ABOUT.
    const streams = createMemoryStreams();
    expect(await streams.read("wrun_stranger", { namespace: "whatever" })).toEqual([]);
    expect(await streams.tail("wrun_stranger", "whatever")).toBe(-1);
    // Nothing was created, so a later write still starts at index 0.
    expect(await streams.write("wrun_stranger", "whatever", "first")).toBe(0);
  });

  test("an EMPTY namespace is the default one, on both sides", async () => {
    // `?namespace=` parses to `""`, and answering it with a channel nobody
    // writes to is an empty progress log with nothing saying why.
    const streams = createMemoryStreams();
    await streams.write("wrun_1", DEFAULT_STREAM_NAMESPACE, "line");
    expect(await streams.read("wrun_1", { namespace: "" })).toHaveLength(1);
  });
});
