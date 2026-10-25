// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { sessionSlot } from "./session-slot.ts";
import { expectSlotContract } from "./testing-slot-contract.ts";

type Log = { lines: string[]; total: number };

describe("expectSlotContract", () => {
  test("passes for a slot that keeps all three invariants", () => {
    const log = sessionSlot("log", (): Log => ({ lines: [], total: 0 }), {
      caps: { lines: 3 },
      view: (value) => ({ count: value.lines.length }),
    });
    expect(() =>
      expectSlotContract(log, {
        write: (draft) => {
          draft.total += 1;
        },
        caps: { lines: 3 },
      }),
    ).not.toThrow();
  });

  test("passes with no options, for a slot whose default is the whole claim", () => {
    const counter = sessionSlot("counter", () => ({ n: 0 }));
    expect(() => expectSlotContract(counter)).not.toThrow();
  });

  test("a default already past its cap drifts the empty frame from the default's projection", () => {
    const log = sessionSlot("log", (): Log => ({ lines: ["a", "b", "c", "d"], total: 0 }), {
      caps: { lines: 2 },
    });
    expect(() => expectSlotContract(log)).toThrow("projected() is not the view of create()");
  });

  test("a SHARED default object is refused before it can leak", () => {
    const shared: Log = { lines: [], total: 0 };
    const log = sessionSlot("log", () => shared);
    expect(() => expectSlotContract(log)).toThrow("create() returned the SAME object twice");
  });

  test("a write that changes nothing proves nothing, and says so", () => {
    const log = sessionSlot("log", (): Log => ({ lines: [], total: 0 }));
    expect(() => expectSlotContract(log, { write: () => undefined })).toThrow(
      "left the value equal to the default",
    );
  });

  test("a cap restated wrongly fails naming the key", () => {
    const log = sessionSlot("log", (): Log => ({ lines: [], total: 0 }), { caps: { lines: 3 } });
    expect(() => expectSlotContract(log, { caps: { lines: 2 } })).toThrow(
      "caps.lines = 2 did not keep the newest 2",
    );
  });

  test("a cap on a key that is not an array of the default is refused by name", () => {
    const log = sessionSlot("log", (): Log => ({ lines: [], total: 0 }));
    expect(() => expectSlotContract(log, { caps: { total: 3 } })).toThrow(
      "caps.total names no top-level array",
    );
  });

  test("a slot with no cap keeps everything, which the restated cap then reports", () => {
    // The other half of the previous case: the claim is about what SURVIVES,
    // so an uncapped slot fails a restated cap rather than passing by accident.
    const log = sessionSlot("log", (): Log => ({ lines: [], total: 0 }));
    expect(() => expectSlotContract(log, { caps: { lines: 3 } })).toThrow("caps.lines = 3");
  });
});
