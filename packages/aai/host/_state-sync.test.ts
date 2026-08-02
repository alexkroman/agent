// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { MAX_CLIENT_EVENT_PAYLOAD_BYTES } from "../sdk/constants.ts";
import { createStateSync } from "./_state-sync.ts";

describe("createStateSync", () => {
  test("pushes the projection, then stays quiet until it changes", () => {
    const sync = createStateSync((s: { cart: string[]; pin: string }) => ({ cart: s.cart }));
    const state = { cart: ["margherita"], pin: "1234" };

    expect(sync(state)).toEqual({ push: true, state: { cart: ["margherita"] } });
    // A tool ran but touched nothing the projection covers. Most turns are
    // this one, and this socket also carries 384 kbps of PCM.
    expect(sync(state)).toEqual({ push: false, reason: "unchanged" });

    state.cart.push("pepperoni");
    expect(sync(state)).toEqual({ push: true, state: { cart: ["margherita", "pepperoni"] } });
  });

  test("a field outside the projection never moves the wire", () => {
    // The whole reason syncState is a projection: `pin` is in state and must
    // not reach a browser, and changing it must not even cost a frame.
    const sync = createStateSync((s: { cart: string[]; pin: string }) => ({ cart: s.cart }));
    const state = { cart: [], pin: "1234" };
    expect(sync(state).push).toBe(true);
    state.pin = "9999";
    expect(sync(state)).toEqual({ push: false, reason: "unchanged" });
  });

  test("a throwing projection reports rather than escaping", () => {
    // It runs in a `finally` around the tool call — an author bug here must
    // not take down a tool call that already succeeded.
    const sync = createStateSync(() => {
      throw new Error("bad projection");
    });
    expect(sync({})).toEqual({ push: false, reason: "failed", detail: "bad projection" });
  });

  test("an unserializable projection reports rather than escaping", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const sync = createStateSync(() => cyclic);
    const result = sync({});
    expect(result.push).toBe(false);
    expect(result).toMatchObject({ reason: "failed" });
  });

  test("refuses a projection over the payload cap", () => {
    const sync = createStateSync(() => ({ blob: "x".repeat(MAX_CLIENT_EVENT_PAYLOAD_BYTES) }));
    const result = sync({});
    expect(result).toMatchObject({ push: false, reason: "too-large" });
  });

  test("an over-cap projection is not remembered, so a later small one sends", () => {
    // The cap must not poison the comparison: shrinking back under it has to
    // reach the client.
    let big = true;
    const sync = createStateSync(() => (big ? "x".repeat(MAX_CLIENT_EVENT_PAYLOAD_BYTES) : "ok"));
    const state = {};
    expect(sync(state).push).toBe(false);
    big = false;
    expect(sync(state)).toEqual({ push: true, state: "ok" });
  });

  test("tracks each session's state object independently", () => {
    // Keyed by the state object, so two live sessions with identical values
    // each get their own first push rather than one silencing the other.
    const sync = createStateSync((s: { n: number }) => s.n);
    const a = { n: 1 };
    const b = { n: 1 };
    expect(sync(a).push).toBe(true);
    expect(sync(b).push).toBe(true);
    expect(sync(a)).toEqual({ push: false, reason: "unchanged" });
  });

  test("a projection returning undefined is a value, not a skip", () => {
    // `JSON.stringify(undefined)` is undefined, which would compare equal to
    // "never sent" forever; it is normalized to null so the client learns the
    // state is empty and the second call correctly says nothing changed.
    const sync = createStateSync(() => undefined);
    const state = {};
    expect(sync(state)).toEqual({ push: true, state: null });
    expect(sync(state)).toEqual({ push: false, reason: "unchanged" });
  });
});
