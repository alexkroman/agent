// Copyright 2026 the AAI authors. MIT license.
/**
 * End-to-end specs for durable resume: a session's `ctx.state` and its
 * provider session id surviving the PROCESS, not just the socket.
 *
 * These drive two real runtimes over one store — which is what a sandbox
 * restart looks like from the session's point of view — rather than testing
 * the store and the persistence layer in isolation. The unit-level properties
 * live in session-store.test.ts and session-persistence.test.ts; what is only
 * observable here is that the runtime WIRES them: that a tool call's mutation
 * reaches the store, that a resumed session's first tool call sees it, and
 * that the replacement transport presents the previous process's provider id.
 */

import { describe, expect, test, vi } from "vitest";
import type { Db } from "../sdk/db.ts";
import { assemblyAIS2s } from "../sdk/providers/s2s/assemblyai.ts";
import { makeAgent, makeClientSink, makeMockHandle, silentLogger } from "./_test-utils.ts";
import { createRuntime } from "./runtime.ts";
import type { ConnectS2sOptions, S2sCallbacks, S2sHandle } from "./s2s.ts";
import { createMemorySessionStore, type SessionStore } from "./session-store.ts";
import { _internals } from "./transports/s2s-transport.ts";

const ENV = { ASSEMBLYAI_API_KEY: "k" };

/** An S2S agent with one tool that counts its calls on `ctx.state`. */
function countingAgent() {
  return makeAgent({
    s2s: assemblyAIS2s(),
    tools: {
      bump: {
        description: "Bump a counter on ctx.state",
        execute: (_args: unknown, ctx: { state: Record<string, unknown> }) => {
          ctx.state.n = ((ctx.state.n ?? 0) as number) + 1;
          return String(ctx.state.n);
        },
      },
    },
  });
}

/** Intercept the provider connection, exposing each socket's handle + callbacks. */
function spyConnect(): { handles: S2sHandle[]; callbacks: S2sCallbacks[] } {
  const handles: S2sHandle[] = [];
  const callbacks: S2sCallbacks[] = [];
  vi.spyOn(_internals, "connectS2s").mockImplementation((opts: ConnectS2sOptions) => {
    callbacks.push(opts.callbacks);
    const handle = makeMockHandle();
    handles.push(handle);
    return Promise.resolve(handle);
  });
  return { handles, callbacks };
}

/** Boot a runtime, open `sessionId` on it, and report what the provider saw. */
async function runProcess(
  store: SessionStore | undefined,
  sessionId: string,
): Promise<{
  runtime: ReturnType<typeof createRuntime>;
  handles: S2sHandle[];
  callbacks: S2sCallbacks[];
}> {
  const { handles, callbacks } = spyConnect();
  const runtime = createRuntime({
    agent: countingAgent(),
    env: ENV,
    logger: silentLogger,
    ...(store ? { sessionStore: store } : {}),
  });
  const session = runtime.createSession({
    id: sessionId,
    agent: "a",
    client: makeClientSink(),
  });
  await session.start();
  return { runtime, handles, callbacks };
}

describe("durable resume across a process restart", () => {
  test("a replacement runtime restores ctx.state and rejoins the provider session", async () => {
    const store = createMemorySessionStore();

    // ── Process 1: a live session does some work. ──
    const first = await runProcess(store, "s1");
    first.callbacks[0]?.onSessionReady("prov-1");
    expect(await first.runtime.executeTool("bump", {}, "s1", [])).toBe("1");
    // The mirror is fire-and-forget, so wait for it rather than assuming it.
    await vi.waitFor(async () => {
      expect(await store.load("s1")).toEqual({ state: { n: 1 }, providerSessionId: "prov-1" });
    });
    await first.runtime.shutdown();
    vi.restoreAllMocks();

    // ── Process 2: nothing in memory, same store, same session id. ──
    const second = await runProcess(store, "s1");

    // The provider session is rejoined rather than opened blank...
    expect(second.handles[0]?.resumeSession).toHaveBeenCalledWith("prov-1");
    expect(second.handles[0]?.updateSession).not.toHaveBeenCalled();
    // ...and the agent has not forgotten the conversation.
    expect(await second.runtime.executeTool("bump", {}, "s1", [])).toBe("2");
    await second.runtime.shutdown();
  });

  test("without a store the same restart starts from scratch — the pre-change behaviour", async () => {
    // The counterpart of the test above, and the reason this option is opt-in:
    // a runtime with no store is unchanged, including in what it loses.
    const first = await runProcess(undefined, "s1");
    first.callbacks[0]?.onSessionReady("prov-1");
    expect(await first.runtime.executeTool("bump", {}, "s1", [])).toBe("1");
    await first.runtime.shutdown();
    vi.restoreAllMocks();

    const second = await runProcess(undefined, "s1");
    expect(second.handles[0]?.updateSession).toHaveBeenCalled();
    expect(second.handles[0]?.resumeSession).not.toHaveBeenCalled();
    expect(await second.runtime.executeTool("bump", {}, "s1", [])).toBe("1");
    await second.runtime.shutdown();
  });

  test("a session the store never saw opens normally", async () => {
    const store = createMemorySessionStore();
    const fresh = await runProcess(store, "brand-new");
    expect(fresh.handles[0]?.updateSession).toHaveBeenCalled();
    expect(fresh.handles[0]?.resumeSession).not.toHaveBeenCalled();
    await fresh.runtime.shutdown();
  });

  test("a store that cannot be read does not stop the session starting", async () => {
    // Degrading to a fresh session is the pre-store behaviour; failing to
    // start is a regression the store must never be able to cause.
    const store = createMemorySessionStore();
    vi.spyOn(store, "load").mockRejectedValue(new Error("no route to host"));
    const { runtime, handles } = await runProcess(store, "s1");
    expect(handles[0]?.updateSession).toHaveBeenCalled();
    expect(await runtime.executeTool("bump", {}, "s1", [])).toBe("1");
    await runtime.shutdown();
  });

  test("two sessions do not share a snapshot", async () => {
    const store = createMemorySessionStore();
    const { runtime } = await runProcess(store, "s1");
    expect(await runtime.executeTool("bump", {}, "s1", [])).toBe("1");
    expect(await runtime.executeTool("bump", {}, "s2", [])).toBe("1");
    await vi.waitFor(async () => {
      expect((await store.load("s2"))?.state).toEqual({ n: 1 });
    });
    expect((await store.load("s1"))?.state).toEqual({ n: 1 });
    await runtime.shutdown();
  });
});

/**
 * An in-memory stand-in for the app database, answering the four statements
 * `createDbSessionStore` issues. Enough to prove the SQL round-trips through
 * the store's own code rather than through a hand-held fake.
 */
function fakeAppDb(): Db {
  const rows = new Map<string, unknown>();
  return {
    query: (<T>(sql: string, params: unknown[] = []) => {
      const id = params[0] as string;
      if (sql.includes("create table")) return Promise.resolve([] as T[]);
      if (sql.includes("select snapshot")) {
        const snapshot = rows.get(id);
        return Promise.resolve((snapshot === undefined ? [] : [{ snapshot }]) as T[]);
      }
      if (sql.includes("insert into")) {
        rows.set(id, JSON.parse(params[1] as string));
        return Promise.resolve([] as T[]);
      }
      // The two deletes: by session id, and the opportunistic expiry sweep
      // (which has no id to remove and is a no-op against a fresh map).
      if (sql.startsWith("delete from") && typeof id === "string" && rows.has(id)) rows.delete(id);
      return Promise.resolve([] as T[]);
    }) as Db["query"],
  };
}

describe("the deployed path: agent({ persistSessions: true })", () => {
  /** A runtime holding no `sessionStore` — exactly what the guest harness builds. */
  async function runDeployed(db: Db | undefined, sessionId: string) {
    const { handles, callbacks } = spyConnect();
    const runtime = createRuntime({
      agent: makeAgent({
        s2s: assemblyAIS2s(),
        persistSessions: true,
        tools: countingAgent().tools,
      }),
      env: ENV,
      logger: silentLogger,
      ...(db ? { db } : {}),
    });
    const session = runtime.createSession({ id: sessionId, agent: "a", client: makeClientSink() });
    await session.start();
    return { runtime, handles, callbacks };
  }

  test("resumes across a restart with no sessionStore option anywhere", async () => {
    // The whole point of the config field: it rides the ordinary agent config
    // into a deployed guest, and the runtime builds the store over the `Db` it
    // already opened for `ctx.db`. No server or harness change involved.
    const db = fakeAppDb();

    const first = await runDeployed(db, "s1");
    first.callbacks[0]?.onSessionReady("prov-1");
    expect(await first.runtime.executeTool("bump", {}, "s1", [])).toBe("1");
    await vi.waitFor(async () => {
      expect(await db.query("select snapshot from t where session_id = $1", ["s1"])).toHaveLength(
        1,
      );
    });
    await first.runtime.shutdown();
    vi.restoreAllMocks();

    const second = await runDeployed(db, "s1");
    expect(second.handles[0]?.resumeSession).toHaveBeenCalledWith("prov-1");
    expect(await second.runtime.executeTool("bump", {}, "s1", [])).toBe("2");
    await second.runtime.shutdown();
  });

  test("without storage it warns once at startup and runs unchanged", async () => {
    const warn = vi.fn();
    spyConnect();
    const runtime = createRuntime({
      agent: makeAgent({ s2s: assemblyAIS2s(), persistSessions: true }),
      env: ENV,
      logger: { ...silentLogger, warn },
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("aai storage enable"));
    // Not fatal: the agent still starts and serves sessions.
    const session = runtime.createSession({ id: "s1", agent: "a", client: makeClientSink() });
    await expect(session.start()).resolves.toBeUndefined();
    await runtime.shutdown();
  });
});
