// Copyright 2026 the AAI authors. MIT license.
/**
 * What the in-heap reference backend does that the shared case list leaves to
 * each backend: it is not durable, its reads are copies, and a `discard` of a
 * session bound to a client keeps the event log the client listing reads.
 * The contract itself is `../conformance.test.ts`'s memory arm.
 */

import { describe, expect, test, vi } from "vitest";
import { createMemoryStateBackend } from "./memory.ts";

describe("createMemoryStateBackend", () => {
  test("names itself and is not durable", () => {
    const backend = createMemoryStateBackend();
    expect(backend.name).toBe("memory");
    expect(backend.durable).toBe(false);
  });

  test("a loaded map is a copy, so mutating it does not reach the store", async () => {
    const backend = createMemoryStateBackend();
    await backend.commit("s1", new Map([["cart", "[]"]]));
    const loaded = await backend.load("s1");
    loaded.set("cart", '["stolen"]');
    expect(await backend.load("s1")).toEqual(new Map([["cart", "[]"]]));
  });

  test("discard drops slots and events, unless a client is bound — then the log stays", async () => {
    const backend = createMemoryStateBackend();
    await backend.commit("plain", new Map([["a", "1"]]));
    await backend.appendEvents("plain", [{ index: 0, json: "{}" }]);
    await backend.discard("plain");
    expect(await backend.load("plain")).toEqual(new Map());
    expect(await backend.countEvents("plain")).toBe(0);

    await backend.bindClient?.("bound", "client-1");
    await backend.commit("bound", new Map([["a", "1"]]));
    await backend.appendEvents("bound", [{ index: 0, json: "{}" }]);
    await backend.discard("bound");
    expect(await backend.load("bound")).toEqual(new Map());
    expect(await backend.countEvents("bound")).toBe(1);
  });

  test("an append moves a bound session's lastEventAt, and the listing is newest-first", async () => {
    vi.useFakeTimers({ now: 1000 });
    try {
      const backend = createMemoryStateBackend();
      await backend.bindClient?.("older", "c");
      vi.setSystemTime(2000);
      await backend.bindClient?.("newer", "c");
      vi.setSystemTime(5000);
      await backend.appendEvents("older", [{ index: 0, json: "{}" }]);
      expect(await backend.clientSessions?.("c", { limit: 10 })).toEqual([
        { sessionId: "newer", startedAt: 2000, lastEventAt: 2000 },
        { sessionId: "older", startedAt: 1000, lastEventAt: 5000 },
      ]);
      expect(await backend.clientSessions?.("c", { since: 3000, limit: 10 })).toEqual([
        { sessionId: "older", startedAt: 1000, lastEventAt: 5000 },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
