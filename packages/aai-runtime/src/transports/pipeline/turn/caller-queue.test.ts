// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { createCallerTurnQueue } from "./caller-queue.ts";
import { createTurnGate } from "./gate.ts";

function queue() {
  const gate = createTurnGate();
  return { gate, callers: createCallerTurnQueue(gate) };
}

describe("createCallerTurnQueue", () => {
  test("utterances committed before the waiting turn starts join it, in order", () => {
    const { callers } = queue();
    const waiting = callers.commit("hello?", undefined);
    expect(waiting).toBeDefined();
    expect(callers.commit("are you there?", undefined)).toBeUndefined();
    expect(callers.commit("it is order 1234", undefined)).toBeUndefined();
    expect(waiting?.take()).toEqual({
      text: "hello? are you there? it is order 1234",
      utterances: ["hello?", "are you there?", "it is order 1234"],
      note: undefined,
    });
  });

  test("once the turn has started, the next utterance opens a turn of its own", () => {
    const { callers } = queue();
    callers.commit("first", undefined)?.take();
    const next = callers.commit("second", undefined);
    expect(next?.take()).toMatchObject({ text: "second", utterances: ["second"] });
  });

  test("a non-caller turn queued in between seals the waiting turn", () => {
    const { callers } = queue();
    const first = callers.commit("first", undefined);
    callers.seal();
    const second = callers.commit("second", undefined);
    expect(second).toBeDefined();
    expect(first?.take()).toMatchObject({ text: "first", utterances: ["first"] });
  });

  test("a moved queue epoch stops a stranded turn from gathering", () => {
    const { gate, callers } = queue();
    const stranded = callers.commit("hello?", undefined);
    gate.invalidateQueued();
    const next = callers.commit("never mind", undefined);
    expect(next?.take()).toMatchObject({ text: "never mind", utterances: ["never mind"] });
    expect(stranded?.take()).toMatchObject({ text: "hello?", utterances: ["hello?"] });
  });

  test("model-only notes are carried and joined", () => {
    const { callers } = queue();
    const waiting = callers.commit("a", "note one");
    callers.commit("b", undefined);
    callers.commit("c", "note two");
    expect(waiting?.take().note).toBe("note one\n\nnote two");
  });
});
