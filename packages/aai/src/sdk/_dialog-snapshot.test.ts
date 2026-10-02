// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { createActor, createMachine } from "xstate";
import {
  assertDialogSource,
  machineFromSpec,
  readState,
  statePaths,
  toStatePath,
} from "./_dialog-snapshot.ts";

describe("toStatePath", () => {
  test("a leaf state is its own name", () => {
    expect(toStatePath("greeting")).toBe("greeting");
  });

  test("a compound state is dotted, down to the leaf", () => {
    expect(toStatePath({ quote: { pending: "waiting" } })).toBe("quote.pending.waiting");
  });

  test("parallel regions are comma-separated", () => {
    expect(toStatePath({ a: "x", b: "y" })).toBe("a.x,b.y");
  });

  test("anything that is not a StateValue reads as the empty path", () => {
    expect(toStatePath(undefined)).toBe("");
    expect(toStatePath(3)).toBe("");
  });
});

describe("readState", () => {
  test("reads the wrapper this module stores", () => {
    const snapshot = { status: "active", value: "a" };
    expect(readState({ snapshot })).toEqual({ snapshot });
  });

  test.each([undefined, null, "a", {}, { snapshot: "a" }])(
    "answers undefined for a value this module did not write: %j",
    (value) => {
      expect(readState(value)).toBeUndefined();
    },
  );
});

describe("statePaths", () => {
  test("lists every state at every depth, as `when` may name either", () => {
    const machine = createMachine({
      initial: "a",
      states: { a: {}, quote: { initial: "pending", states: { pending: {}, done: {} } } },
    });
    expect([...statePaths(machine)].sort()).toEqual(["a", "quote", "quote.done", "quote.pending"]);
  });
});

describe("machineFromSpec", () => {
  test("builds a real machine, id'd by the dialog key, that transitions on its events", () => {
    const machine = machineFromSpec("checkout", {
      initial: "cart",
      states: {
        cart: { on: { PAY: "paid" } },
        paid: { final: true },
      },
    });
    expect(machine.id).toBe("checkout");
    const actor = createActor(machine).start();
    actor.send({ type: "PAY" });
    expect(actor.getSnapshot().value).toBe("paid");
    expect(actor.getSnapshot().status).toBe("done");
    actor.stop();
  });

  test("nests a state's own states, reachable by the dotted path", () => {
    const machine = machineFromSpec("d", {
      initial: "quote",
      states: { quote: { initial: "pending", states: { pending: {} } } },
    });
    expect(statePaths(machine)).toEqual(new Set(["quote", "quote.pending"]));
    expect(toStatePath(createActor(machine).getSnapshot().value)).toBe("quote.pending");
  });
});

describe("assertDialogSource", () => {
  test("accepts a record — a spec or a machine", () => {
    expect(() => assertDialogSource({ initial: "a", states: {} })).not.toThrow();
  });

  test("refuses a call that put something other than a spec where the key goes", () => {
    expect(() => assertDialogSource(undefined)).toThrow(/takes the KEY first/);
  });
});
