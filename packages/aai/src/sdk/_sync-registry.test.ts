// Copyright 2026 the AAI authors. MIT license.
/**
 * `sessionSlot(key, create, { sync: true })` → `agent()`'s default
 * `syncState`.
 *
 * Its own file because the registry is MODULE state: a slot declared here
 * stays registered for every later `agent()` call in this module graph, which
 * is the behaviour under test and the reason it must not leak into a suite
 * that asserts an agent syncs nothing.
 */
import { describe, expect, test } from "vitest";
import { normalizeAgentParams } from "./_author-conveniences.ts";
import { syncedProjections } from "./_sync-registry.ts";
import { agent } from "./define.ts";
import { sessionSlot } from "./session-slot.ts";

/** `syncState` off a normalized params record. */
function syncStateOf(params: unknown): unknown {
  return (params as { syncState?: unknown }).syncState;
}

describe("sync: true", () => {
  // ONE test, because the registry is module state and the runner shuffles
  // test order: each step below reads what the step before it registered.
  test("feeds agent() in declaration order unless the agent declares its own", () => {
    expect(syncedProjections()).toEqual([]);
    expect(syncStateOf(normalizeAgentParams({ name: "p" }))).toBeUndefined();

    const cart = sessionSlot("cart", () => ({ items: [] as string[] }), {
      view: (cart) => ({ count: cart.items.length }),
      sync: true,
    });
    expect(syncedProjections()).toEqual([cart.projected]);
    expect(syncStateOf(normalizeAgentParams({ name: "p" }))).toEqual({ cart: cart.projected });
    expect(agent({ name: "p" }).syncState).toEqual({ cart: cart.projected });

    // An explicit syncState wins, and an unsynced slot is not collected.
    const prefs = sessionSlot("prefs", () => ({ units: "metric" }));
    expect(syncedProjections().map((p) => p.key)).toEqual(["cart"]);
    expect(agent({ name: "p", syncState: prefs.projected }).syncState).toEqual({
      prefs: prefs.projected,
    });

    // A second synced slot joins the frame after the first.
    const desk = sessionSlot("desk", () => ({ open: 0 }), { sync: true });
    expect(Object.keys(agent({ name: "p" }).syncState ?? {})).toEqual(["cart", "desk"]);
    expect(agent({ name: "p" }).syncState?.desk).toBe(desk.projected);

    // Two synced slots on one key are refused where the collision is named.
    sessionSlot("desk", () => ({ open: 1 }), { sync: true });
    expect(() => agent({ name: "p" })).toThrow(/projects the "desk" slot twice/);
  });
});
