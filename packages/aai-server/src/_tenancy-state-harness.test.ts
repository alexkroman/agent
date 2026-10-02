// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { applySessionOp, applyUploadOp, pair, type StateTables } from "./_tenancy-state-harness.ts";

const A = "tenancy-alpha" as const;
const B = "tenancy-beta" as const;

const tables = (): StateTables => ({ uploads: new Map(), slots: new Map(), events: new Map() });

describe("the uploads reference", () => {
  test("a claim is refused for a taken id, even for an identical declaration", () => {
    const t = tables();
    const claim = { t: "claimUpload", slug: A, id: "up0", name: "a.wav", expected: 3 } as const;
    expect(applyUploadOp(t, claim)).toEqual({ ok: undefined });
    expect(applyUploadOp(t, claim)).toEqual({ refused: "upload-taken" });
  });

  test("a window write changes the size and parts, a finish leaves the parts alone", () => {
    const t = tables();
    applyUploadOp(t, { t: "claimUpload", slug: A, id: "up0", name: "a.wav", expected: undefined });
    applyUploadOp(t, { t: "updateUpload", slug: A, id: "up0", size: 4, complete: false });
    applyUploadOp(t, { t: "finishUpload", slug: A, id: "up0", size: 9 });
    expect(applyUploadOp(t, { t: "readUpload", slug: A, id: "up0" })).toEqual({
      ok: {
        name: "a.wav",
        type: "audio/wav",
        size: 9,
        complete: true,
        expected: undefined,
        parts: [{ at: 0, bytes: 4 }],
      },
    });
  });

  test("a write to an id this bucket does not hold is a silent no-op", () => {
    const t = tables();
    applyUploadOp(t, { t: "finishUpload", slug: A, id: "ghost", size: 1 });
    expect(applyUploadOp(t, { t: "readUpload", slug: A, id: "ghost" })).toEqual({ ok: undefined });
  });
});

describe("the session-state reference", () => {
  test("slots round-trip, and events read back in index order from a start", () => {
    const t = tables();
    applySessionOp(t, { t: "commitSlots", slug: A, sessionId: "s", values: { a: "1" } }, [t]);
    applySessionOp(
      t,
      {
        t: "appendEvents",
        slug: A,
        sessionId: "s",
        events: [
          { index: 2, event: "c" },
          { index: 0, event: "a" },
          { index: 1, event: "b" },
        ],
      },
      [t],
    );
    expect(applySessionOp(t, { t: "loadSlots", slug: A, sessionId: "s" }, [t])).toEqual({
      ok: { a: "1" },
    });
    expect(
      applySessionOp(t, { t: "readEvents", slug: A, sessionId: "s", startIndex: 1, limit: 5 }, [t]),
    ).toEqual({
      ok: [
        { index: 1, event: "b" },
        { index: 2, event: "c" },
      ],
    });
  });

  test("a re-appended index is ignored, and the next index is one past the HIGHEST", () => {
    const t = tables();
    const append = (index: number, event: string) =>
      applySessionOp(
        t,
        { t: "appendEvents", slug: A, sessionId: "s", events: [{ index, event }] },
        [t],
      );
    append(5, "first");
    append(5, "retry");
    expect(t.events.get(pair("s", 5))?.event).toBe("first");
    expect(applySessionOp(t, { t: "nextEventIndex", slug: A, sessionId: "s" }, [t])).toEqual({
      ok: 6,
    });
    expect(applySessionOp(t, { t: "nextEventIndex", slug: A, sessionId: "none" }, [t])).toEqual({
      ok: 0,
    });
  });

  test("discard drops events only from the buckets it is given", () => {
    const mine = tables();
    const theirs = tables();
    for (const [t, slug] of [
      [mine, A],
      [theirs, B],
    ] as const) {
      applySessionOp(
        t,
        { t: "appendEvents", slug, sessionId: "s", events: [{ index: 0, event: "e" }] },
        [t],
      );
    }
    applySessionOp(mine, { t: "discardSession", slug: A, sessionId: "s" }, [mine]);
    expect(mine.events.size).toBe(0);
    expect(theirs.events.size).toBe(1);
    // The leak shape: handed the neighbour's bucket too, it deletes there.
    applySessionOp(mine, { t: "discardSession", slug: A, sessionId: "s" }, [mine, theirs]);
    expect(theirs.events.size).toBe(0);
  });
});
