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

  test("a slot whose `after` derives a field is held to the default AS STORED, not to create() raw", () => {
    const log = sessionSlot("log", (): Log => ({ lines: [], total: 0 }), {
      caps: { lines: 3 },
      after: (value) => {
        value.total = value.lines.length + 100;
      },
      view: (value) => ({ count: value.lines.length, total: value.total }),
    });
    expect(() =>
      expectSlotContract(log, {
        write: (draft) => {
          draft.lines.push("hello");
        },
        caps: { lines: 3 },
      }),
    ).not.toThrow();
  });

  test("a slot declaring `empty` is held to its empty frame, not to the seeded default", () => {
    const log = sessionSlot("log", (): Log => ({ lines: ["seed"], total: 0 }), {
      empty: (): Log => ({ lines: [], total: 0 }),
      view: (value) => ({ count: value.lines.length }),
    });
    expect(() =>
      expectSlotContract(log, {
        write: (draft) => {
          draft.lines.push("more");
        },
      }),
    ).not.toThrow();
  });

  test("a seeded slot whose `after` derives a field passes too — the hook applies to the blank", () => {
    const log = sessionSlot("log", (): Log => ({ lines: ["seed"], total: -1 }), {
      empty: (): Log => ({ lines: [], total: -1 }),
      after: (value) => {
        value.total = value.lines.length;
      },
      view: (value) => ({ count: value.lines.length, total: value.total }),
    });
    expect(() => expectSlotContract(log)).not.toThrow();
  });

  test("a projection that disagrees with the stored blank is named", () => {
    // A `projected` that was rebuilt by hand, projecting a different frame.
    const log = sessionSlot("log", (): Log => ({ lines: [], total: 0 }));
    const broken = {
      ...log,
      projected: Object.assign(
        (value?: unknown) => (value === undefined ? { lines: ["ghost"], total: 0 } : value),
        log.projected,
      ),
    };
    expect(() => expectSlotContract(broken)).toThrow(
      "projected() is not the view of the slot's blank",
    );
  });

  test("a default already past its restated cap is reported under that cap", () => {
    const log = sessionSlot("log", (): Log => ({ lines: ["a", "b", "c", "d"], total: 0 }), {
      caps: { lines: 2 },
    });
    expect(() => expectSlotContract(log, { caps: { lines: 2 } })).toThrow(
      "caps.lines = 2, but the default already holds 4 entries",
    );
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

  test("a declared cap is checked with no `caps` option at all, read off the handle", () => {
    const wrongEnd = sessionSlot("wrong-end", () => ({ log: [] as string[] }), {
      caps: { log: 2 },
      // A slot whose hook keeps the OLDEST two: the cap then trims nothing.
      after: (v) => {
        v.log.splice(2);
      },
    });
    expect(() => expectSlotContract(wrongEnd)).toThrow(
      /caps\.log = 2 did not keep the newest 2 .* The slot trims the wrong end\./,
    );
    expect(() =>
      expectSlotContract(
        sessionSlot("declared-ok", () => ({ log: [] as string[] }), { caps: { log: 2 } }),
      ),
    ).not.toThrow();
  });

  test("a restated cap that disagrees with the declaration names both numbers", () => {
    const slot = sessionSlot("disagree", () => ({ log: [] as string[] }), { caps: { log: 5 } });
    expect(() => expectSlotContract(slot, { caps: { log: 2 } })).toThrow(
      /The slot declares caps\.log = 5, not 2\./,
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
