// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the runtime's durable-resume mirror.
 *
 * The properties worth pinning here are the ones a store implementation
 * cannot enforce on its own: that the live map WINS over a stored snapshot,
 * that a store failure degrades to a fresh session rather than a failed one,
 * that hydration is ordered ahead of `transport.start()`, and that a tool call
 * which changed nothing costs no write.
 */

import { describe, expect, test, vi } from "vitest";
import { flush } from "./_test-utils.ts";
import type { Logger } from "./runtime-config.ts";
import { createSessionPersistence, type StartableSession } from "./session-persistence.ts";
import { createMemorySessionStore, type SessionStore } from "./session-store.ts";

function fakeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

/** A `StartableSession` whose `start` is a spy — no cast needed, which is the
 *  point of `wrapStart` taking the one method it replaces. */
function fakeCore(): StartableSession & { started: ReturnType<typeof vi.fn> } {
  const started = vi.fn(() => Promise.resolve());
  return { started, start: started };
}

function setup(store?: SessionStore) {
  const stateMap = new Map<string, Record<string, unknown>>();
  const logger = fakeLogger();
  const persistence = createSessionPersistence({ sessionStore: store, stateMap, logger });
  return { stateMap, logger, persistence };
}

describe("with no store configured", () => {
  test("every method is inert, so the runtime is unchanged", async () => {
    const { persistence, stateMap } = setup(undefined);
    const core = fakeCore();
    const afterHydrate = vi.fn();
    persistence.wrapStart(core, "s1", afterHydrate);
    persistence.touch("s1");
    persistence.forget("s1");
    const hooks = persistence.providerSession("s1");
    hooks.onProviderSession("prov-1");
    expect(hooks.resumeProviderSession()).toBeUndefined();
    // wrapStart left `start` alone: no hydration step, no extra push.
    await core.start();
    expect(core.started).toHaveBeenCalledTimes(1);
    expect(afterHydrate).not.toHaveBeenCalled();
    expect(stateMap.size).toBe(0);
  });
});

describe("mirroring state", () => {
  test("touch writes the live state through to the store", async () => {
    const store = createMemorySessionStore();
    const { persistence, stateMap } = setup(store);
    stateMap.set("s1", { cart: ["apple"] });
    persistence.touch("s1");
    await vi.waitFor(async () => {
      expect(await store.load("s1")).toEqual({ state: { cart: ["apple"] } });
    });
  });

  test("a session with nothing to remember is not written at all", async () => {
    const store = createMemorySessionStore();
    const save = vi.spyOn(store, "save");
    const { persistence } = setup(store);
    persistence.touch("never-ran-a-tool");
    await flush();
    expect(save).not.toHaveBeenCalled();
  });

  test("an unchanged state costs no second write", async () => {
    const store = createMemorySessionStore();
    const save = vi.spyOn(store, "save");
    const { persistence, stateMap } = setup(store);
    stateMap.set("s1", { turn: 1 });
    persistence.touch("s1");
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    // Most tool calls never touch state, and `touch` runs after every one.
    persistence.touch("s1");
    persistence.touch("s1");
    await flush();
    expect(save).toHaveBeenCalledTimes(1);
    // A real change writes again.
    stateMap.set("s1", { turn: 2 });
    persistence.touch("s1");
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  });

  test("a failed write is retried by the next touch rather than deduped away", async () => {
    const store = createMemorySessionStore();
    // `Once` only — every later call falls through to the real store, so the
    // assertion below reads the write rather than the mock.
    const save = vi.spyOn(store, "save").mockRejectedValueOnce(new Error("connection reset"));
    const { persistence, stateMap, logger } = setup(store);
    stateMap.set("s1", { turn: 1 });
    persistence.touch("s1");
    await vi.waitFor(() => expect(logger.warn).toHaveBeenCalled());
    // Same state as the failed attempt: the dedupe key must not have been
    // recorded, or the retry would be skipped and the write lost forever.
    persistence.touch("s1");
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(await store.load("s1")).toEqual({ state: { turn: 1 } });
  });

  test("state that cannot be serialized warns once and never throws", async () => {
    const store = createMemorySessionStore();
    const { persistence, stateMap, logger } = setup(store);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    stateMap.set("s1", cyclic);
    persistence.touch("s1");
    await vi.waitFor(() => expect(logger.warn).toHaveBeenCalledTimes(1));
    persistence.touch("s1");
    persistence.touch("s1");
    await flush();
    // Latched: the condition is a property of the agent's state shape, so one
    // line per session rather than one per tool call.
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});

describe("hydrating a resume", () => {
  test("loads the stored snapshot before start() and pushes it to the client", async () => {
    const store = createMemorySessionStore();
    await store.save("s1", { state: { cart: ["apple"] }, providerSessionId: "prov-1" });
    const { persistence, stateMap } = setup(store);
    const core = fakeCore();
    const order: string[] = [];
    core.started.mockImplementation(() => {
      order.push("start");
      return Promise.resolve();
    });
    persistence.wrapStart(core, "s1", () => order.push("push"));

    await core.start();

    expect(stateMap.get("s1")).toEqual({ cart: ["apple"] });
    // The client push has to follow hydration, and the transport has to
    // follow both — a cold `session.resume` reads the id inside start().
    expect(order).toEqual(["push", "start"]);
    expect(persistence.providerSession("s1").resumeProviderSession()).toBe("prov-1");
  });

  test("a live entry wins over the store — a dropped socket is not a dead process", async () => {
    const store = createMemorySessionStore();
    await store.save("s1", { state: { turn: 1 } });
    const { persistence, stateMap } = setup(store);
    // Still resident: this copy is newer than anything written, so reading
    // over it would roll the session back.
    const live = { turn: 7 };
    stateMap.set("s1", live);
    const core = fakeCore();
    persistence.wrapStart(core, "s1", () => undefined);
    await core.start();
    expect(stateMap.get("s1")).toBe(live);
  });

  test("a store that cannot be read starts fresh rather than failing the session", async () => {
    const store = createMemorySessionStore();
    vi.spyOn(store, "load").mockRejectedValue(new Error("no route to host"));
    const { persistence, stateMap, logger } = setup(store);
    const core = fakeCore();
    await expect(core.start()).resolves.toBeUndefined();
    persistence.wrapStart(core, "s1", () => undefined);
    await expect(core.start()).resolves.toBeUndefined();
    expect(core.started).toHaveBeenCalledTimes(2);
    expect(stateMap.has("s1")).toBe(false);
    expect(logger.warn).toHaveBeenCalled();
  });

  test("no snapshot means an ordinary fresh session", async () => {
    const { persistence, stateMap } = setup(createMemorySessionStore());
    const core = fakeCore();
    persistence.wrapStart(core, "cold", () => undefined);
    await core.start();
    expect(stateMap.has("cold")).toBe(false);
    expect(core.started).toHaveBeenCalledTimes(1);
  });
});

describe("the provider session id", () => {
  test("is persisted as soon as the provider reports it", async () => {
    const store = createMemorySessionStore();
    const { persistence } = setup(store);
    // An S2S session can run for minutes before its first tool call, so this
    // must not wait for one.
    persistence.providerSession("s1").onProviderSession("prov-1");
    await vi.waitFor(async () => {
      expect(await store.load("s1")).toEqual({ state: {}, providerSessionId: "prov-1" });
    });
  });

  test("an unchanged id does not trigger a write", async () => {
    const store = createMemorySessionStore();
    const save = vi.spyOn(store, "save");
    const { persistence } = setup(store);
    const hooks = persistence.providerSession("s1");
    hooks.onProviderSession("prov-1");
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    hooks.onProviderSession("prov-1");
    await flush();
    expect(save).toHaveBeenCalledTimes(1);
  });

  test("a re-issued id replaces the one a resume presented", async () => {
    const store = createMemorySessionStore();
    const { persistence } = setup(store);
    const hooks = persistence.providerSession("s1");
    hooks.onProviderSession("prov-1");
    hooks.onProviderSession("prov-2");
    await vi.waitFor(() => expect(hooks.resumeProviderSession()).toBe("prov-2"));
    expect((await store.load("s1"))?.providerSessionId).toBe("prov-2");
  });
});

describe("forget", () => {
  test("drops the stored snapshot on the same deadline as the in-process map", async () => {
    const store = createMemorySessionStore();
    await store.save("s1", { state: { turn: 1 } });
    const { persistence } = setup(store);
    persistence.forget("s1");
    await vi.waitFor(async () => {
      expect(await store.load("s1")).toBeNull();
    });
  });

  test("a failed delete is logged, not thrown into the sweep timer", async () => {
    const store = createMemorySessionStore();
    vi.spyOn(store, "delete").mockRejectedValue(new Error("gone"));
    const { persistence, logger } = setup(store);
    expect(() => persistence.forget("s1")).not.toThrow();
    await vi.waitFor(() => expect(logger.warn).toHaveBeenCalled());
  });

  test("clears the dedupe key, so a re-used id is written again rather than skipped", async () => {
    const store = createMemorySessionStore();
    const save = vi.spyOn(store, "save");
    const { persistence, stateMap } = setup(store);
    stateMap.set("s1", { turn: 1 });
    persistence.touch("s1");
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    persistence.forget("s1");
    persistence.touch("s1");
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  });
});
