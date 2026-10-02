// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { createActor, setup } from "xstate";
import { actorStore } from "./_actor-store.ts";

const toggle = setup({ types: { events: {} as { type: "FLIP" } } }).createMachine({
  initial: "off",
  states: { off: { on: { FLIP: "on" } }, on: { on: { FLIP: "off" } } },
});

describe("actorStore", () => {
  test("starts the actor, forwards events and notifies subscribers", () => {
    const actor = createActor(toggle);
    const store = actorStore(actor, () => actor.getSnapshot().value);
    expect(store.getView()).toBe("off");
    let calls = 0;
    const unsubscribe = store.subscribe(() => {
      calls++;
    });
    store.send({ type: "FLIP" });
    expect(store.getView()).toBe("on");
    expect(calls).toBe(1);
    unsubscribe();
    store.send({ type: "FLIP" });
    expect(calls).toBe(1);
  });

  test("stop() stops the actor", () => {
    const actor = createActor(toggle);
    const store = actorStore(actor, () => actor.getSnapshot().status);
    store.stop();
    expect(store.getView()).toBe("stopped");
  });
});
