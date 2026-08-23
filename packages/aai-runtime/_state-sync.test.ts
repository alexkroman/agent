// Copyright 2026 the AAI authors. MIT license.

import { sessionSlot } from "@alexkroman1/aai";
import { MAX_CLIENT_EVENT_PAYLOAD_BYTES } from "@alexkroman1/aai/internal";
import { describe, expect, test } from "vitest";
import { createStateSync, type StateSyncSession } from "./_state-sync.ts";

/**
 * A session as the store presents one — the values, plus the last-sent record.
 *
 * Written here rather than driven through the real store because these are the
 * decision's own failure modes, and the store's job (hydrate, commit, reclaim) is
 * its own suite.
 */
function fakeSession(values: Record<string, unknown> = {}): StateSyncSession & {
  set(key: string, value: unknown): void;
} {
  let lastPush: string | undefined;
  const held = new Map(Object.entries(values));
  return {
    read: (key) => held.get(key),
    lastPush: () => lastPush,
    recordPush: (json) => {
      lastPush = json;
    },
    set: (key, value) => held.set(key, value),
  };
}

const cartSlot = sessionSlot("cart", () => ({ cart: [] as string[], pin: "" }));
const cartOnly = cartSlot.projection((s) => ({ cart: s.cart }));

describe("createStateSync", () => {
  test("pushes the projection, then stays quiet until it changes", () => {
    const sync = createStateSync([cartOnly]);
    const session = fakeSession({ cart: { cart: ["margherita"], pin: "1234" } });

    expect(sync(session)).toEqual({ push: true, state: { cart: ["margherita"] } });
    // A tool ran but touched nothing the projection covers. Most turns are
    // this one, and this socket also carries 384 kbps of PCM.
    expect(sync(session)).toEqual({ push: false, reason: "unchanged" });

    session.set("cart", { cart: ["margherita", "pepperoni"], pin: "1234" });
    expect(sync(session)).toEqual({ push: true, state: { cart: ["margherita", "pepperoni"] } });
  });

  test("a field outside the projection never moves the wire", () => {
    // The whole reason syncState is a projection: `pin` is in state and must
    // not reach a browser, and changing it must not even cost a frame.
    const sync = createStateSync([cartOnly]);
    const session = fakeSession({ cart: { cart: [], pin: "1234" } });
    expect(sync(session).push).toBe(true);
    session.set("cart", { cart: [], pin: "9999" });
    expect(sync(session)).toEqual({ push: false, reason: "unchanged" });
  });

  test("projects the slot's DEFAULT for a session that has run no tool", () => {
    // What replaced `AgentDef.state`: the projection carries the slot's factory,
    // so a resumed connection has something to render before the first tool call
    // without the agent having declared a state factory to build it.
    const sync = createStateSync([cartOnly]);
    expect(sync(fakeSession())).toEqual({ push: true, state: { cart: [] } });
  });

  test("merges every projection into one frame", () => {
    const flagSlot = sessionSlot("flags", () => ({ seen: false }));
    const sync = createStateSync([cartOnly, flagSlot.projection((f) => ({ seen: f.seen }))]);
    const session = fakeSession({
      cart: { cart: ["a"], pin: "" },
      flags: { seen: true },
    });
    expect(sync(session)).toEqual({ push: true, state: { cart: ["a"], seen: true } });
  });

  test("one slot changing pushes the whole merged frame", () => {
    const flagSlot = sessionSlot("flags", () => ({ seen: false }));
    const sync = createStateSync([cartOnly, flagSlot.projection((f) => ({ seen: f.seen }))]);
    const session = fakeSession({ cart: { cart: [], pin: "" }, flags: { seen: false } });
    expect(sync(session).push).toBe(true);
    session.set("flags", { seen: true });
    expect(sync(session)).toEqual({ push: true, state: { cart: [], seen: true } });
  });

  test("a non-object projection is fine ALONE and refused in a merge", () => {
    // Alone, the projection IS the frame, so any JSON value is legal — which is
    // what lets a single-slot agent project a number or a list. In a merge there
    // is nothing to merge a number INTO, and a projection returning one is the
    // author's mistake, reported like a throwing one.
    const count = cartSlot.projection((s) => s.cart.length);
    expect(createStateSync([count])(fakeSession())).toEqual({ push: true, state: 0 });

    const flagSlot = sessionSlot("flags", () => ({ seen: false }));
    const merged = createStateSync([count, flagSlot.projection((f) => ({ seen: f.seen }))]);
    expect(merged(fakeSession())).toMatchObject({ push: false, reason: "failed" });
    expect(merged(fakeSession())).toMatchObject({ detail: expect.stringContaining("cart") });
  });

  test("a throwing projection reports rather than escaping", () => {
    // It runs in a `finally` around the tool call — an author bug here must
    // not take down a tool call that already succeeded.
    const sync = createStateSync([
      cartSlot.projection(() => {
        throw new Error("bad projection");
      }),
    ]);
    expect(sync(fakeSession())).toEqual({
      push: false,
      reason: "failed",
      detail: "bad projection",
    });
  });

  test("an unserializable projection reports rather than escaping", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const sync = createStateSync([cartSlot.projection(() => cyclic)]);
    expect(sync(fakeSession())).toMatchObject({ push: false, reason: "failed" });
  });

  test("refuses a projection over the payload cap", () => {
    const sync = createStateSync([
      cartSlot.projection(() => ({ blob: "x".repeat(MAX_CLIENT_EVENT_PAYLOAD_BYTES) })),
    ]);
    expect(sync(fakeSession())).toMatchObject({ push: false, reason: "too-large" });
  });

  test("an over-cap projection is not remembered, so a later small one sends", () => {
    // The cap must not poison the comparison: shrinking back under it has to
    // reach the client.
    let big = true;
    const sync = createStateSync([
      cartSlot.projection(() => (big ? "x".repeat(MAX_CLIENT_EVENT_PAYLOAD_BYTES) : "ok")),
    ]);
    const session = fakeSession();
    expect(sync(session).push).toBe(false);
    big = false;
    expect(sync(session)).toEqual({ push: true, state: "ok" });
  });

  test("tracks each session independently", () => {
    // Two live sessions with identical values each get their own first push
    // rather than one silencing the other — the record is per session, held
    // beside that session's values.
    const sync = createStateSync([cartOnly]);
    const a = fakeSession();
    const b = fakeSession();
    expect(sync(a).push).toBe(true);
    expect(sync(b).push).toBe(true);
    expect(sync(a)).toEqual({ push: false, reason: "unchanged" });
  });

  test("a projection returning undefined is a value, not a skip", () => {
    // `JSON.stringify(undefined)` is undefined, which would compare equal to
    // "never sent" forever; it is normalized to null so the client learns the
    // state is empty and the second call correctly says nothing changed.
    const sync = createStateSync([cartSlot.projection(() => undefined)]);
    const session = fakeSession();
    expect(sync(session)).toEqual({ push: true, state: null });
    expect(sync(session)).toEqual({ push: false, reason: "unchanged" });
  });

  test("force sends an unchanged projection, for a client that just arrived", () => {
    // The resume case. State survives a disconnect, so the values and their
    // projection are identical — but the socket is new and has seen nothing.
    // Staleness is a property of the client, not of the state.
    const sync = createStateSync([cartOnly]);
    const session = fakeSession({ cart: { cart: ["a"], pin: "" } });
    expect(sync(session)).toEqual({ push: true, state: { cart: ["a"] } });
    expect(sync(session)).toEqual({ push: false, reason: "unchanged" });
    expect(sync(session, { force: true })).toEqual({ push: true, state: { cart: ["a"] } });
    // And the forced send still updates the record, so the next ordinary
    // call is quiet again rather than re-sending.
    expect(sync(session)).toEqual({ push: false, reason: "unchanged" });
  });

  test("force does not bypass the payload cap", () => {
    // A resume must not become the one path that can blow the wire budget.
    const sync = createStateSync([
      cartSlot.projection(() => "x".repeat(MAX_CLIENT_EVENT_PAYLOAD_BYTES)),
    ]);
    expect(sync(fakeSession(), { force: true })).toMatchObject({
      push: false,
      reason: "too-large",
    });
  });
});
