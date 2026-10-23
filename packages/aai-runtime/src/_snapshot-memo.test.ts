// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { createActor, createMachine } from "xstate";
import { memoOnSnapshot } from "./_snapshot-memo.ts";

const machine = createMachine({
  initial: "a",
  states: { a: { on: { NEXT: "b", NOOP: {} } }, b: {} },
});

describe("memoOnSnapshot", () => {
  test("answers what a fresh matches() would, across a transition", () => {
    const actor = createActor(machine).start();
    const inB = memoOnSnapshot(actor, (s) => s.matches("b"));
    expect(inB()).toBe(false);
    actor.send({ type: "NEXT" });
    expect(inB()).toBe(true);
  });

  test("recomputes only when the snapshot object changes", () => {
    let calls = 0;
    let snapshot = { n: 1 };
    const memo = memoOnSnapshot({ getSnapshot: () => snapshot }, (s) => {
      calls += 1;
      return s.n;
    });
    expect([memo(), memo(), memo()]).toEqual([1, 1, 1]);
    expect(calls).toBe(1);
    snapshot = { n: 2 };
    expect(memo()).toBe(2);
    expect(calls).toBe(2);
  });
});
