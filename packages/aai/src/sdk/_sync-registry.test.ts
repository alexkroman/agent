// Copyright 2026 the AAI authors. MIT license.
/**
 * `sessionSlot(key, create, { sync: true })` → `agent()`'s default
 * `syncState`, and the CLAIM that keeps one agent's slots out of the next.
 *
 * Its own file because the registry is MODULE state: a slot declared here
 * stays registered for the rest of this module graph, which is the behaviour
 * under test and the reason it must not leak into a suite that asserts an
 * agent syncs nothing.
 */
import { describe, expect, test } from "vitest";
import { normalizeAgentParams } from "./_author-conveniences.ts";
import { syncedProjections } from "./_sync-registry.ts";
import { agent, workflowApp } from "./define.ts";
import { sessionSlot } from "./session-slot.ts";
import { withTools } from "./tool-registry.ts";
import { workflow } from "./workflow.ts";

/** `syncState` off a normalized params record. */
function syncStateOf(params: unknown): unknown {
  return (params as { syncState?: unknown }).syncState;
}

describe("sync: true", () => {
  // ONE test, because the registry is module state and the runner shuffles
  // test order: each step below reads what the step before it registered.
  test("feeds the first agent() that collects it, in declaration order, unless the agent declares its own", () => {
    expect(syncedProjections()).toEqual([]);
    expect(syncStateOf(normalizeAgentParams({ name: "p" }))).toBeUndefined();

    const cart = sessionSlot("cart", () => ({ items: [] as string[] }), {
      view: (cart) => ({ count: cart.items.length }),
      sync: true,
    });
    expect(syncedProjections()).toEqual([cart.projected]);
    const first = agent({ name: "p" });
    expect(first.syncState).toEqual({ cart: cart.projected });

    // CLAIMED by that agent: a second agent declared in the same process — a
    // template suite, a monorepo spec — does not inherit the first one's slot.
    expect(agent({ name: "q" }).syncState).toBeUndefined();
    expect(syncStateOf(normalizeAgentParams({ name: "q" }))).toBeUndefined();

    // An explicit syncState wins, and an unsynced slot is not collected.
    const prefs = sessionSlot("prefs", () => ({ units: "metric" }));
    expect(syncedProjections().map((p) => p.key)).toEqual(["cart"]);
    expect(agent({ name: "p", syncState: prefs.projected }).syncState).toEqual({
      prefs: prefs.projected,
    });

    // A second synced slot goes to the next agent that collects — and only to it.
    const desk = sessionSlot("desk", () => ({ open: 0 }), { sync: true });
    const second = agent({ name: "r" });
    expect(second.syncState).toEqual({ desk: desk.projected });
    expect(agent({ name: "s" }).syncState).toBeUndefined();

    // A slot synced AFTER the agent was built — a `tools/*.ts` module, which
    // the generated entry imports after `agent.ts` — joins THAT agent at the
    // lowering (`withTools`) and at the config boundary, where every module has
    // evaluated: its collected record is extended, never replaced.
    const late = sessionSlot("late", () => ({ n: 0 }), { sync: true });
    expect(Object.keys(second.syncState ?? {})).toEqual(["desk"]);
    const lowered = withTools(second, {});
    expect(Object.keys(lowered.syncState ?? {})).toEqual(["desk", "late"]);
    expect(lowered.syncState?.late).toBe(late.projected);
    expect(Object.keys(syncStateOf(normalizeAgentParams(lowered)) as object)).toEqual([
      "desk",
      "late",
    ]);
    // Idempotent: nothing new registered, the same record comes back.
    expect(withTools(lowered, {}).syncState).toBe(lowered.syncState);
    // A def that had no synced slot when it was built collects at the lowering too.
    const later = sessionSlot("later", () => ({ n: 0 }), { sync: true });
    expect(syncStateOf(withTools({ tools: {} }, {}))).toEqual({ later: later.projected });
    // A DECLARED syncState is never re-collected, at either step.
    const declared = agent({ name: "p", syncState: prefs.projected });
    sessionSlot("stray", () => ({ n: 0 }), { sync: true });
    expect(withTools(declared, {}).syncState).toEqual({ prefs: prefs.projected });
    expect(syncStateOf(normalizeAgentParams(declared))).toEqual({ prefs: prefs.projected });
    expect(agent({ name: "t" }).syncState).toHaveProperty("stray");

    // Two synced slots on one key are refused where the collision is named.
    sessionSlot("twice", () => ({ open: 1 }), { sync: true });
    sessionSlot("twice", () => ({ open: 2 }), { sync: true });
    expect(() => agent({ name: "p" })).toThrow(/projects the "twice" slot twice/);

    // A workflow app never collects — and so never meets its own refusal. The
    // failure this pins: `templates.test.ts` declares every template's
    // agent in one process, and a `workflowApp()` declared after a voice
    // agent's `sync: true` slot used to inherit that projection, then throw
    // "`syncState` … has no effect on a \"workflow-app\" agent".
    const voiceSlot = sessionSlot("voice-only", () => ({ n: 0 }), { sync: true });
    const digest = workflow({ run: async () => ({}) });
    const app = workflowApp({ name: "App", workflows: { digest } });
    expect(app.syncState).toBeUndefined();
    expect(withTools(app, {}).syncState).toBeUndefined();
    expect(syncStateOf(normalizeAgentParams(app))).toBeUndefined();
    // The slot is still there for the next voice agent — the app claimed nothing.
    expect(agent({ name: "voice" }).syncState).toEqual({ "voice-only": voiceSlot.projected });
    expect(agent({ name: "another" }).syncState).toBeUndefined();
  });
});
