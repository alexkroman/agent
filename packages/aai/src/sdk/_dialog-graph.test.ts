// Copyright 2026 the AAI authors. MIT license.
/**
 * The graph guard, driven through `dialog()` rather than called directly —
 * that is the only way an author reaches it, and it is where the two inputs
 * (`statePaths` and the compiled machine) are brought together.
 *
 * The negative cases matter more than the positive ones here. XState accepts an
 * unreachable state and a wedged one silently (measured against 5.32, see the
 * module doc), so every "does not throw" case below is a claim that this guard
 * has not become a second source of false refusals — a gate that rejects legal
 * dialogs would be worse than the two bugs it catches.
 */

import { describe, expect, test } from "vitest";
import { createMachine, setup } from "xstate";
import { dialog } from "./dialog.ts";

describe("unreachable states", () => {
  test("a state nothing targets is refused, and the message names it", () => {
    expect(() =>
      dialog("call", {
        initial: "greeting",
        states: {
          greeting: { instruction: "Say hello.", on: { DONE: "greeting" } },
          ghost: { instruction: "Never given to the model.", on: { X: "greeting" } },
        },
      }),
    ).toThrow(/can never reach ghost/);
  });

  test("every unreachable state is named, not just the first", () => {
    expect(() =>
      dialog("call", {
        initial: "a",
        states: {
          a: { on: { LOOP: "a" } },
          y: { on: { X: "a" } },
          z: { on: { X: "a" } },
        },
      }),
    ).toThrow(/can never reach y, z/);
  });

  test("a state reachable only as a compound's initial child is NOT unreachable", () => {
    // The regression this exists for: "reachable" is not "targeted by some
    // transition". Nothing sends an event at `working.triaging` — entering
    // `working` is what puts the dialog there.
    expect(() =>
      dialog("call", {
        initial: "standby",
        states: {
          standby: { on: { LOGGED: "working" } },
          working: {
            initial: "triaging",
            on: { RESET: "standby" },
            states: { triaging: {} },
          },
        },
      }),
    ).not.toThrow();
  });

  test("a state reached only through an absolute #id target is NOT unreachable", () => {
    // Targets are read off the state nodes XState already resolved, so the
    // three spellings (sibling, `.child`, `#id.path`) cost nothing here.
    expect(() =>
      dialog("call", {
        initial: "serving",
        states: {
          serving: {
            initial: "helping",
            states: { helping: { on: { BAIL: "#call.transferred" } } },
          },
          transferred: { final: true },
        },
      }),
    ).not.toThrow();
  });
});

describe("wedged states", () => {
  test("a non-final leaf with no way out is refused, and the message names it", () => {
    expect(() =>
      dialog("intake", {
        initial: "name",
        states: {
          name: { instruction: "Ask for their name.", on: { SUBMIT: "address" } },
          address: { instruction: "Ask for their address." },
        },
      }),
    ).toThrow(/can never leave address/);
  });

  test("a final leaf is where a dialog is SUPPOSED to stop", () => {
    expect(() =>
      dialog("intake", {
        initial: "name",
        states: { name: { on: { SUBMIT: "done" } }, done: { final: true } },
      }),
    ).not.toThrow();
  });

  test("a leaf whose only exit is declared on its PARENT is not wedged", () => {
    // `dispatch-center`'s shape: the leaves carry the instructions, the parent
    // carries the escape. A per-state check would report all three as wedged.
    expect(() =>
      dialog("call", {
        initial: "working",
        states: {
          working: {
            initial: "triaging",
            on: { RESET: ".triaging" },
            states: { triaging: {}, dispatching: {} },
          },
        },
      }),
    ).toThrow(/can never reach working.dispatching/);
  });

  test("a leaf left only by an eventless `always` is not wedged", () => {
    // XState keeps `always` off the `transitions` map, so a guard that read one
    // and not the other would refuse this — the exact bug shape it exists to
    // catch, one level up.
    const machine = createMachine({
      id: "call",
      initial: "deciding",
      states: {
        deciding: { on: { GO: "routing" } },
        routing: { always: { target: "deciding" } },
      },
    });
    expect(() => dialog("call", machine)).not.toThrow();
  });

  test("a leaf left only by an invoked actor's onDone is not wedged", () => {
    // `onDone`/`onError`/`after` are desugared INTO `transitions` by XState, so
    // reading that map is what makes the guard safe on a hand-written machine.
    const machine = setup({ actors: {} }).createMachine({
      id: "call",
      initial: "waiting",
      states: {
        waiting: { after: { 1000: "done" } },
        done: { type: "final" },
      },
    });
    expect(() => dialog("call", machine)).not.toThrow();
  });

  test("a dialog that declares no transition at all is a constant, not a wedge", () => {
    // The boundary, not an exemption: the defect is "the author drew a graph
    // with a hole in it", and this author drew no graph. Nothing moved, so
    // nothing got stuck, and "give it an outgoing event" would be advice to
    // write a different feature.
    expect(() =>
      dialog("bare", { initial: "only", states: { only: { instruction: "Just be here." } } }),
    ).not.toThrow();
  });
});

describe("what the guard must NOT refuse", () => {
  test("a cycle is what a healthy dialog IS", () => {
    // Stated because the obvious library for a graph check is a topological
    // sort, which reports every one of these as unsafe.
    expect(() =>
      dialog("gate", {
        initial: "browsing",
        states: {
          browsing: { on: { STAGED: "awaitingConfirmation" } },
          awaitingConfirmation: { on: { SETTLED: "browsing" } },
        },
      }),
    ).not.toThrow();
  });

  test("the initial-state check still runs, and runs FIRST", () => {
    // Folded in from `_dialog-snapshot.ts`; first because an unresolvable
    // initial makes every other answer here meaningless.
    expect(() =>
      dialog("call", { initial: "typo", states: { greeting: { on: { X: "greeting" } } } }),
    ).toThrow(/starts in "typo"/);
  });
});
