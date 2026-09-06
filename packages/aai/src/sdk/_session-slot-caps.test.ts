// Copyright 2026 the AAI authors. MIT license.
/**
 * What this pins is WHERE a cap holds — on every path that stores, whatever
 * wrote — and the one ordering decision `SessionSlotOptions.caps` documents:
 * the cap runs after `after`, so a hook that appends cannot overshoot it and a
 * hook that counts sees the untrimmed draft.
 */

import { describe, expect, test } from "vitest";
import { compileSlotCaps } from "./_session-slot-caps.ts";
import { sessionSlot } from "./session-slot.ts";
import { createToolContext } from "./testing.ts";

type Desk = { log: string[]; findings: string[]; open: string | null; count: number };

const emptyDesk = (): Desk => ({ log: [], findings: [], open: null, count: 0 });

describe("compileSlotCaps", () => {
  test("no caps compiles to the identity", () => {
    const apply = compileSlotCaps<Desk>("desk", undefined);
    const desk = emptyDesk();
    desk.log.push("a", "b");
    expect(apply(desk)).toBe(desk);
    expect(desk.log).toEqual(["a", "b"]);
  });

  test("trims IN PLACE, dropping the OLDEST", () => {
    const apply = compileSlotCaps<Desk>("desk", { log: 2 });
    const desk = { ...emptyDesk(), log: ["a", "b", "c", "d"] };
    expect(apply(desk)).toBe(desk);
    expect(desk.log).toEqual(["c", "d"]);
  });

  test("a value at or under its cap is untouched", () => {
    const apply = compileSlotCaps<Desk>("desk", { log: 2, findings: 3 });
    const desk = { ...emptyDesk(), log: ["a", "b"], findings: ["x"] };
    apply(desk);
    expect(desk.log).toEqual(["a", "b"]);
    expect(desk.findings).toEqual(["x"]);
  });

  test("zero keeps nothing, as pushCapped(…, 0) does", () => {
    const apply = compileSlotCaps<Desk>("desk", { log: 0 });
    expect(apply({ ...emptyDesk(), log: ["a"] }).log).toEqual([]);
  });

  test("refuses a cap that is not a non-negative integer, naming slot and key", () => {
    expect(() => compileSlotCaps<Desk>("desk", { log: -1 })).toThrow(
      'sessionSlot("desk"): caps.log must be a non-negative integer — got -1.',
    );
    expect(() => compileSlotCaps<Desk>("desk", { log: 2.5 })).toThrow(/caps\.log/);
    expect(() => compileSlotCaps<Desk>("desk", { findings: Number.NaN })).toThrow(/caps\.findings/);
    expect(() => compileSlotCaps<Desk>("desk", { findings: Number.POSITIVE_INFINITY })).toThrow(
      /caps\.findings/,
    );
  });

  test("a value that is not a record, or a key that is not an array, passes through", () => {
    // `SlotCaps` admits a key whose array sits behind `null`; at run time the
    // slot may hold the `null`, and there is nothing to trim.
    type Maybe = { log: string[] | null };
    const apply = compileSlotCaps<Maybe>("maybe", { log: 1 });
    expect(apply({ log: null })).toEqual({ log: null });
    const primitive = compileSlotCaps<number>("count", undefined);
    expect(primitive(7)).toBe(7);
  });
});

describe("sessionSlot({ caps })", () => {
  const deskSlot = sessionSlot("desk", emptyDesk, { caps: { log: 3, findings: 2 } });

  test("holds the cap on update, whatever the mutator pushed", () => {
    const ctx = createToolContext();
    deskSlot.update(ctx, (desk) => {
      for (const line of ["a", "b", "c", "d", "e"]) desk.log.push(line);
    });
    expect(deskSlot.get(ctx).log).toEqual(["c", "d", "e"]);
  });

  test("holds it across updates — the stored value never exceeds it", () => {
    const ctx = createToolContext();
    for (const line of ["a", "b", "c", "d"]) {
      deskSlot.update(ctx, (desk) => desk.log.push(line));
    }
    expect(deskSlot.get(ctx).log).toEqual(["b", "c", "d"]);
  });

  test("holds it on set, on the copy rather than the caller's object", () => {
    const ctx = createToolContext();
    const restored: Desk = { ...emptyDesk(), findings: ["x", "y", "z"] };
    expect(deskSlot.set(ctx, restored).findings).toEqual(["y", "z"]);
    // `set` stores a COPY; the caller's list is theirs and is left whole.
    expect(restored.findings).toEqual(["x", "y", "z"]);
  });

  test("holds it on the DEFAULT — get, reset and the projection's empty frame", () => {
    const wide = sessionSlot("wide", () => ({ log: ["a", "b", "c"] }), { caps: { log: 2 } });
    const ctx = createToolContext();
    expect(wide.get(ctx).log).toEqual(["b", "c"]);
    expect(wide.reset(ctx).log).toEqual(["b", "c"]);
    expect(wide.projection((v) => v.log)()).toEqual(["b", "c"]);
  });

  test("each capped array is independent, and uncapped fields are untouched", () => {
    const ctx = createToolContext();
    deskSlot.update(ctx, (desk) => {
      desk.log.push("1", "2", "3", "4");
      desk.findings.push("x", "y", "z");
      desk.open = "m1";
      desk.count = 9;
    });
    expect(deskSlot.get(ctx)).toEqual({
      log: ["2", "3", "4"],
      findings: ["y", "z"],
      open: "m1",
      count: 9,
    });
  });

  test("runs AFTER the author's `after` hook, so a hook that appends cannot overshoot", () => {
    const slot = sessionSlot("audited", emptyDesk, {
      caps: { log: 3 },
      after: (desk) => {
        desk.log.push(`audit: ${desk.count}`);
      },
    });
    const ctx = createToolContext();
    slot.update(ctx, (desk) => {
      desk.log.push("a", "b", "c");
      desk.count = 1;
    });
    // Four entries went in (three plus the hook's); the cap has the last word.
    expect(slot.get(ctx).log).toEqual(["b", "c", "audit: 1"]);
  });

  test("…which means the hook sees the UNTRIMMED draft — the documented price", () => {
    const seen: number[] = [];
    const slot = sessionSlot("counted", emptyDesk, {
      caps: { log: 2 },
      after: (desk) => {
        seen.push(desk.log.length);
        // A derived field reading the TAIL is unaffected by the trim.
        desk.open = desk.log.at(-1) ?? null;
      },
    });
    const ctx = createToolContext();
    slot.update(ctx, (desk) => desk.log.push("a", "b", "c", "d"));
    expect(seen).toEqual([4]);
    expect(slot.get(ctx)).toMatchObject({ log: ["c", "d"], open: "d" });
  });

  test("a throwing mutator still stores nothing", () => {
    const ctx = createToolContext();
    deskSlot.update(ctx, (desk) => desk.log.push("kept"));
    expect(() =>
      deskSlot.update(ctx, (desk) => {
        desk.log.push("1", "2", "3", "4");
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(deskSlot.get(ctx).log).toEqual(["kept"]);
  });

  test("a bad cap is refused at DECLARATION, before any session exists", () => {
    expect(() => sessionSlot("bad", emptyDesk, { caps: { log: -3 } })).toThrow(
      /sessionSlot\("bad"\): caps\.log/,
    );
  });

  test("an array behind `null` is still cappable; a non-array key is a compile error", () => {
    // The compile-error half is `_session-slot-caps.test-d.ts` — a type claim
    // belongs in a type test, not behind a suppression the hatch ratchet counts.
    // An array behind `null` IS accepted, so a nullable list can still be bound.
    const nullable = sessionSlot("nullable", (): { log: string[] | null } => ({ log: null }), {
      caps: { log: 3 },
    });
    expect(nullable.key).toBe("nullable");
  });
});
