// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test, vi } from "vitest";
import { createMemoryAgentRows } from "./agent-store.ts";
import { createMemoryChatStore } from "./chat-store.ts";
import {
  createMemoryPlatformEvents,
  withAgentEvents,
  withChatEvents,
  withWorkspaceEvents,
} from "./platform-events.ts";
import { createMemoryWorkspaceStore } from "./workspace-store.ts";

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

const AGENT = {
  slug: "a",
  credential_hashes: [],
  config: { name: "a", systemPrompt: "s", greeting: "", toolSchemas: [] },
  worker_hash: "h",
  client_files: {},
} as never;

describe("createMemoryPlatformEvents", () => {
  test("agent watchers hear emits until unwatched", async () => {
    const memory = createMemoryPlatformEvents();
    const seen: string[] = [];
    const unwatch = memory.events.watchAgents((slug) => seen.push(slug));
    memory.emitAgent("one");
    await flush();
    unwatch();
    memory.emitAgent("two");
    await flush();
    expect(seen).toEqual(["one"]);
  });

  test("workspace watchers are scoped to their (scope, project)", async () => {
    const memory = createMemoryPlatformEvents();
    const mine = vi.fn();
    const other = vi.fn();
    memory.events.watchWorkspace("s1", "p1", mine);
    memory.events.watchWorkspace("s2", "p1", other);
    memory.emitWorkspace("s1", "p1");
    await flush();
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
    await flush();
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
    await flush();
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
    await flush();
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
    await flush();
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
    await flush();
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
    await flush();
    expect(seen).toHaveBeenCalledTimes(2);
  });

  test("withChatEvents emits on put and delete", async () => {
    const memory = createMemoryPlatformEvents();
    const seen = vi.fn();
    memory.events.watchChat("s", "p", seen);
    const store = withChatEvents(createMemoryChatStore(), memory.emitChat);
    await store.putChat("s", "p", [{ id: "m1" }]);
    await store.deleteChat("s", "p");
    await flush();
    expect(seen).toHaveBeenCalledTimes(2);
    expect(await store.getChat("s", "p")).toBeNull();
  });
});
