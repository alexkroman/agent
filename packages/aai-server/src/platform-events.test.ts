// Copyright 2026 the AAI authors. MIT license.

import { sleep } from "@alexkroman1/aai/internal";
import { describe, expect, test, vi } from "vitest";
import { type AgentRecordInput, createMemoryAgentRows } from "./agent-store.ts";
import { createMemoryChatStore } from "./chat-store.ts";
import {
  createMemoryPlatformEvents,
  withAgentEvents,
  withChatEvents,
  withWorkspaceEvents,
} from "./platform-events.ts";
import { createMemoryWorkspaceStore } from "./workspace-store.ts";

// Typed, not `as never`. The cast that used to sit here was carrying a `config`
// column `20260810030000_drop_agents_config.sql` dropped — the platform stores
// no description of a bundle at all — and the cast is exactly what stopped the
// compiler from saying so.
const AGENT: AgentRecordInput = {
  slug: "a",
  credential_hashes: [],
  worker_hash: "h",
  client_files: {},
};

describe("createMemoryPlatformEvents", () => {
  test("agent watchers hear emits until unwatched", async () => {
    const memory = createMemoryPlatformEvents();
    const seen: string[] = [];
    const unwatch = memory.events.watchAgents((slug) => seen.push(slug));
    memory.emitAgent("one");
    await memory.settled();
    unwatch();
    memory.emitAgent("two");
    await memory.settled();
    expect(seen).toEqual(["one"]);
  });

  test("workspace watchers are scoped to their (scope, project)", async () => {
    const memory = createMemoryPlatformEvents();
    const mine = vi.fn();
    const other = vi.fn();
    memory.events.watchWorkspace("s1", "p1", mine);
    memory.events.watchWorkspace("s2", "p1", other);
    memory.emitWorkspace("s1", "p1");
    await memory.settled();
    expect(mine).toHaveBeenCalledOnce();
    expect(other).not.toHaveBeenCalled();
  });

  test("unwatching one workspace watcher leaves its siblings subscribed", async () => {
    const memory = createMemoryPlatformEvents();
    const a = vi.fn();
    const b = vi.fn();
    const unwatchA = memory.events.watchWorkspace("s", "p", a);
    memory.events.watchWorkspace("s", "p", b);
    unwatchA();
    memory.emitWorkspace("s", "p");
    await memory.settled();
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledOnce();
  });

  test("chat watchers are scoped to their (scope, project)", async () => {
    const memory = createMemoryPlatformEvents();
    const mine = vi.fn();
    const other = vi.fn();
    memory.events.watchChat("s1", "p1", mine);
    memory.events.watchChat("s1", "p2", other);
    memory.emitChat("s1", "p1");
    await memory.settled();
    expect(mine).toHaveBeenCalledOnce();
    expect(other).not.toHaveBeenCalled();
  });

  test("a workspace write also fires the scope's project-list watchers", async () => {
    const memory = createMemoryPlatformEvents();
    const scopeWatcher = vi.fn();
    const otherScope = vi.fn();
    memory.events.watchScopeProjects("s1", scopeWatcher);
    memory.events.watchScopeProjects("s2", otherScope);
    memory.emitWorkspace("s1", "p1");
    memory.emitWorkspace("s1", "p2");
    await memory.settled();
    expect(scopeWatcher).toHaveBeenCalledTimes(2);
    expect(otherScope).not.toHaveBeenCalled();
  });

  test("emission is deferred: a watcher's re-read sees the settled store", async () => {
    const memory = createMemoryPlatformEvents();
    let sawDuringEmit = false;
    memory.events.watchAgents(() => {
      sawDuringEmit = true;
    });
    memory.emitAgent("x");
    // Synchronously after emit, nothing has fired yet.
    expect(sawDuringEmit).toBe(false);
    await memory.settled();
    expect(sawDuringEmit).toBe(true);
  });
});

describe("store decorators", () => {
  test("withAgentEvents emits on put and delete", async () => {
    const memory = createMemoryPlatformEvents();
    const seen: string[] = [];
    memory.events.watchAgents((slug) => seen.push(slug));
    const rows = withAgentEvents(createMemoryAgentRows(), memory.emitAgent);
    await rows.put(AGENT);
    await rows.delete("a");
    await memory.settled();
    expect(seen).toEqual(["a", "a"]);
    // Reads still work through the decorator.
    expect(await rows.get("a")).toBeNull();
  });

  test("withWorkspaceEvents emits on put and delete, returns the version", async () => {
    const memory = createMemoryPlatformEvents();
    const seen = vi.fn();
    memory.events.watchWorkspace("s", "p", seen);
    const store = withWorkspaceEvents(createMemoryWorkspaceStore(), memory.emitWorkspace);
    const version = await store.put("s", "p", { files: {} }, null);
    expect(version).toBe(1);
    await store.delete("s", "p");
    await memory.settled();
    expect(seen).toHaveBeenCalledTimes(2);
  });

  // The metadata stamp — every preview/publish/database write goes through
  // `patch`, and it is the one the decorator forgot. Watched here rather than
  // only through the studio because production wraps nothing, so nothing else
  // can catch a mutator that never reaches a watcher.
  test("withWorkspaceEvents emits on patch, and returns the patched record", async () => {
    const memory = createMemoryPlatformEvents();
    const seen = vi.fn();
    memory.events.watchWorkspace("s", "p", seen);
    const store = withWorkspaceEvents(createMemoryWorkspaceStore(), memory.emitWorkspace);
    await store.put("s", "p", { files: {} }, null);
    seen.mockClear();

    const record = await store.patch("s", "p", { set: { previewSlug: "p-preview" } });
    await memory.settled();

    expect(seen).toHaveBeenCalledTimes(1);
    expect(record?.doc).toMatchObject({ previewSlug: "p-preview" });
  });

  test("withWorkspaceEvents stays quiet when there is no row to patch", async () => {
    const memory = createMemoryPlatformEvents();
    const seen = vi.fn();
    memory.events.watchWorkspace("s", "gone", seen);
    const store = withWorkspaceEvents(createMemoryWorkspaceStore(), memory.emitWorkspace);

    expect(await store.patch("s", "gone", { set: { previewSlug: "x" } })).toBeNull();
    await memory.settled();
    expect(seen).not.toHaveBeenCalled();
  });

  test("withChatEvents emits on put and delete", async () => {
    const memory = createMemoryPlatformEvents();
    const seen = vi.fn();
    memory.events.watchChat("s", "p", seen);
    const store = withChatEvents(createMemoryChatStore(), memory.emitChat);
    await store.putChat("s", "p", [{ id: "m1" }]);
    await store.deleteChat("s", "p");
    await memory.settled();
    expect(seen).toHaveBeenCalledTimes(2);
    expect(await store.getChat("s", "p")).toBeNull();
  });
  // ── settled() ──────────────────────────────────────────────────────────────
  // The point of the signal: it waits for the HANDLER, not just for delivery.
  // A fixed number of microtask turns cannot, which is what it replaced.

  test("settled waits out an async handler, however many awaits deep", async () => {
    const memory = createMemoryPlatformEvents();
    let done = false;
    memory.events.watchAgents(async () => {
      // Deeper than any spin loop would have guessed at.
      for (let i = 0; i < 200; i += 1) await Promise.resolve();
      done = true;
    });

    memory.emitAgent("a");
    await memory.settled();

    expect(done).toBe(true);
  });

  test("settled drains work a handler emits while it runs", async () => {
    const memory = createMemoryPlatformEvents();
    const seen: string[] = [];
    // A delete cascades: the first handler's own emit must be waited out too,
    // or settled() reports quiescence one generation early.
    memory.events.watchAgents(async (slug) => {
      await Promise.resolve();
      seen.push(slug);
      if (slug === "first") memory.emitAgent("cascaded");
    });

    memory.emitAgent("first");
    await memory.settled();

    expect(seen).toEqual(["first", "cascaded"]);
  });

  test("a rejecting handler settles rather than rejecting the waiter", async () => {
    const memory = createMemoryPlatformEvents();
    const after = vi.fn();
    memory.events.watchAgents(() => Promise.reject(new Error("handler blew up")));
    memory.events.watchAgents(after);

    memory.emitAgent("a");

    // Handlers own their failures (they all log and swallow); `settled`
    // answering "the work is over" must not become a rejection nobody awaited.
    await expect(memory.settled()).resolves.toBeUndefined();
    expect(after).toHaveBeenCalledWith("a");
  });

  test("settled waits out a handler that yields to a TIMER, not just microtasks", async () => {
    // Killed mutant: `Promise.all([...inFlight])` -> `Promise.all([])`, which
    // turns `settled` into a microtask busy-loop. Every existing spec still
    // passed because their handlers settle on microtasks; a handler that
    // needs a macrotask starves the loop forever.
    const memory = createMemoryPlatformEvents();
    let done = false;
    memory.events.watchAgents(async () => {
      await sleep(5);
      done = true;
    });

    memory.emitAgent("a");
    await memory.settled();

    expect(done).toBe(true);
  });

  test("emitting for a key nobody watches is a no-op", async () => {
    // Killed mutant: `if (!set) return` -> `if (false) return`. This is the
    // ORDINARY production case — a workspace write while no browser is
    // subscribed — and nothing exercised it.
    const memory = createMemoryPlatformEvents();
    const seen = vi.fn();
    memory.events.watchWorkspace("s", "watched", seen);

    memory.emitWorkspace("s", "unwatched");
    memory.emitChat("s", "unwatched");
    await expect(memory.settled()).resolves.toBeUndefined();

    expect(seen).not.toHaveBeenCalled();
  });

  test("unwatching the last watcher drops the key rather than leaking it", async () => {
    // Killed mutant: `if (set.size === 0) watchers.delete(key)` -> `if (false)`.
    // The map is keyed by (scope, project), so without the cleanup every
    // project ever opened stays in it for the process lifetime. Observed
    // through behaviour: after the key is dropped, a later emit takes the
    // no-watchers path above rather than iterating an empty set.
    const memory = createMemoryPlatformEvents();
    const first = vi.fn();
    const unwatch = memory.events.watchWorkspace("s", "p", first);
    unwatch();

    const second = vi.fn();
    memory.events.watchWorkspace("s", "p", second);
    memory.emitWorkspace("s", "p");
    await memory.settled();

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  test("close returns a promise, matching the PlatformEvents contract", async () => {
    // Killed mutant: `() => Promise.resolve()` -> `() => undefined`. Callers
    // `await events.close()` in teardown; a non-thenable works by accident
    // there and breaks anything chaining `.then`/`.finally` off it.
    const memory = createMemoryPlatformEvents();
    const result = memory.events.close();
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBeUndefined();
  });

  test("settled resolves immediately when nothing was emitted", async () => {
    const memory = createMemoryPlatformEvents();
    await expect(memory.settled()).resolves.toBeUndefined();
  });
});
