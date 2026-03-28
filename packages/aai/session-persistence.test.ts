import { afterEach, describe, expect, test, vi } from "vitest";
import { makeClient, makeMockHandle, makeSessionOpts, silentLogger } from "./_test-utils.ts";
import {
  _internals,
  createS2sSession,
  type PersistedSession,
  persistKey,
  type S2sSessionOptions,
  type SessionPersistence,
} from "./session.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** In-memory KV store for testing. */
function makeMemoryKv() {
  const store = new Map<string, { value: string; expiresAt?: number }>();
  return {
    store,
    async get<T>(key: string): Promise<T | null> {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiresAt && Date.now() > entry.expiresAt) {
        store.delete(key);
        return null;
      }
      return JSON.parse(entry.value) as T;
    },
    async set(key: string, value: unknown, opts?: { expireIn?: number }): Promise<void> {
      const entry: { value: string; expiresAt?: number } = { value: JSON.stringify(value) };
      if (opts?.expireIn) entry.expiresAt = Date.now() + opts.expireIn;
      store.set(key, entry);
    },
    async delete(keys: string | string[]): Promise<void> {
      const keyArray = Array.isArray(keys) ? keys : [keys];
      for (const k of keyArray) store.delete(k);
    },
    async list() {
      return [];
    },
    async keys() {
      return [];
    },
  };
}

function makePersistence(kv: ReturnType<typeof makeMemoryKv>): {
  persistence: SessionPersistence;
  state: Record<string, unknown>;
} {
  let state: Record<string, unknown> = {};
  return {
    persistence: {
      kv,
      ttl: 3_600_000,
      getState: () => state,
      setState: (s) => {
        state = s;
      },
    },
    get state() {
      return state;
    },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("session persistence", () => {
  let connectSpy: ReturnType<typeof vi.spyOn>;
  let mockHandle: ReturnType<typeof makeMockHandle>;

  function setup(overrides?: Partial<S2sSessionOptions>) {
    mockHandle = makeMockHandle();
    connectSpy = vi.spyOn(_internals, "connectS2s").mockResolvedValue(mockHandle);
    const client = makeClient();
    const opts = makeSessionOpts({ client, ...overrides });
    const session = createS2sSession(opts);
    return { session, client, opts, mockHandle };
  }

  afterEach(() => {
    connectSpy?.mockRestore();
  });

  test("stop() persists state, messages, and S2S session ID to KV", async () => {
    const kv = makeMemoryKv();
    const { persistence, state } = makePersistence(kv);
    state.counter = 42;
    state.items = ["a", "b"];

    const { session, mockHandle } = setup({ persistence });
    await session.start();

    // Simulate S2S ready with a session ID
    mockHandle._fire("ready", { sessionId: "s2s-abc123" });

    // Simulate some conversation messages
    session.onHistory([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
    ]);

    await session.stop();

    // Verify persisted data
    const persisted = await kv.get<PersistedSession>(persistKey("session-1"));
    expect(persisted).toEqual({
      s2sSessionId: "s2s-abc123",
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there!" },
      ],
      state: { counter: 42, items: ["a", "b"] },
    });
  });

  test("stop() persists with TTL from persistence config", async () => {
    const kv = makeMemoryKv();
    const setSpy = vi.spyOn(kv, "set");
    const { persistence } = makePersistence(kv);
    persistence.ttl = 7_200_000; // 2 hours

    const { session } = setup({ persistence });
    await session.start();
    await session.stop();

    expect(setSpy).toHaveBeenCalledWith(persistKey("session-1"), expect.any(Object), {
      expireIn: 7_200_000,
    });
  });

  test("start() with resumeFrom restores state and messages from KV", async () => {
    const kv = makeMemoryKv();

    // Pre-populate KV with persisted session data
    const persisted: PersistedSession = {
      s2sSessionId: "s2s-old-session",
      messages: [
        { role: "user", content: "Remember me?" },
        { role: "assistant", content: "Of course!" },
      ],
      state: { favoriteColor: "blue", loginCount: 5 },
    };
    await kv.set(persistKey("old-session-1"), persisted);

    const helper = makePersistence(kv);
    const { session, mockHandle } = setup({
      id: "session-2", // New session ID
      persistence: helper.persistence,
      resumeFrom: "old-session-1",
    });

    await session.start();

    // State should be restored (access via helper to get latest reference)
    expect(helper.state).toEqual({ favoriteColor: "blue", loginCount: 5 });

    // S2S session.resume should have been called
    expect(mockHandle.resumeSession).toHaveBeenCalledWith("s2s-old-session");

    // updateSession should NOT have been called (resume takes priority)
    expect(mockHandle.updateSession).not.toHaveBeenCalled();

    // Old persisted data is cleaned up on stop(), not on start()
    const oldDataBeforeStop = await kv.get(persistKey("old-session-1"));
    expect(oldDataBeforeStop).not.toBeNull();

    await session.stop();

    // Now old data should be cleaned up
    const oldDataAfterStop = await kv.get(persistKey("old-session-1"));
    expect(oldDataAfterStop).toBeNull();
  });

  test("resume falls back to updateSession when S2S session expired", async () => {
    const kv = makeMemoryKv();
    const persisted: PersistedSession = {
      s2sSessionId: "s2s-expired-session",
      messages: [{ role: "user", content: "Hello" }],
      state: { count: 1 },
    };
    await kv.set(persistKey("old-session"), persisted);

    const { persistence } = makePersistence(kv);
    const { session, mockHandle } = setup({
      persistence,
      resumeFrom: "old-session",
    });

    await session.start();

    // Verify resume was attempted
    expect(mockHandle.resumeSession).toHaveBeenCalledWith("s2s-expired-session");

    // Simulate S2S returning session_not_found (session expired)
    mockHandle._fire("sessionExpired", {
      code: "session_not_found",
      message: "Session not found",
    });

    // Should fall back to updateSession
    expect(mockHandle.updateSession).toHaveBeenCalledOnce();
    // Handle should NOT be closed (fallback keeps the connection alive)
    expect(mockHandle.close).not.toHaveBeenCalled();
  });

  test("second sessionExpired after fallback closes the handle", async () => {
    const kv = makeMemoryKv();
    const persisted: PersistedSession = {
      s2sSessionId: "s2s-expired",
      messages: [],
      state: {},
    };
    await kv.set(persistKey("old"), persisted);

    const { persistence } = makePersistence(kv);
    const { session, mockHandle } = setup({ persistence, resumeFrom: "old" });
    await session.start();

    // First expiry: triggers fallback
    mockHandle._fire("sessionExpired", {
      code: "session_not_found",
      message: "Session not found",
    });
    expect(mockHandle.close).not.toHaveBeenCalled();

    // Second expiry: default behavior — close
    mockHandle._fire("sessionExpired", {
      code: "session_not_found",
      message: "Session not found",
    });
    expect(mockHandle.close).toHaveBeenCalledOnce();
  });

  test("start() without resumeFrom does not attempt resume", async () => {
    const kv = makeMemoryKv();
    const { persistence } = makePersistence(kv);
    const { session, mockHandle } = setup({ persistence });

    await session.start();

    expect(mockHandle.resumeSession).not.toHaveBeenCalled();
    expect(mockHandle.updateSession).toHaveBeenCalledOnce();
  });

  test("resume with no persisted data falls back to fresh session", async () => {
    const kv = makeMemoryKv();
    const { persistence } = makePersistence(kv);
    const { session, mockHandle } = setup({
      persistence,
      resumeFrom: "nonexistent-session",
    });

    await session.start();

    // No persisted data found, so no resume attempt
    expect(mockHandle.resumeSession).not.toHaveBeenCalled();
    expect(mockHandle.updateSession).toHaveBeenCalledOnce();
  });

  test("stop() without persistence does not write to KV", async () => {
    const { session } = setup(); // No persistence config
    await session.start();
    await session.stop();
    // No error thrown, no KV writes — just the default flow
    expect(mockHandle.close).toHaveBeenCalled();
  });

  test("persistence survives KV write failure gracefully", async () => {
    const kv = makeMemoryKv();
    vi.spyOn(kv, "set").mockRejectedValue(new Error("KV write failed"));
    const { persistence } = makePersistence(kv);

    const { session } = setup({ persistence });
    await session.start();

    // stop() should not throw even if KV write fails
    await expect(session.stop()).resolves.toBeUndefined();
    expect(silentLogger.warn).toHaveBeenCalledWith("Failed to persist session", expect.any(Object));
  });

  test("persistence survives KV read failure on resume", async () => {
    const kv = makeMemoryKv();
    vi.spyOn(kv, "get").mockRejectedValue(new Error("KV read failed"));
    const { persistence } = makePersistence(kv);

    const { session, mockHandle } = setup({
      persistence,
      resumeFrom: "broken-session",
    });

    // start() should not throw even if KV read fails
    await session.start();
    expect(silentLogger.warn).toHaveBeenCalledWith(
      "Failed to restore persisted session",
      expect.any(Object),
    );
    // Falls back to fresh session
    expect(mockHandle.updateSession).toHaveBeenCalledOnce();
  });

  test("resume with null s2sSessionId skips session.resume", async () => {
    const kv = makeMemoryKv();
    const persisted: PersistedSession = {
      s2sSessionId: null,
      messages: [{ role: "user", content: "Hello" }],
      state: { count: 1 },
    };
    await kv.set(persistKey("old"), persisted);

    const { persistence } = makePersistence(kv);
    const { session, mockHandle } = setup({ persistence, resumeFrom: "old" });
    await session.start();

    // State and messages should be restored
    expect(persistence.getState()).toEqual({ count: 1 });

    // But S2S resume should not be attempted (no S2S session ID)
    expect(mockHandle.resumeSession).not.toHaveBeenCalled();
    expect(mockHandle.updateSession).toHaveBeenCalledOnce();
  });

  test("round-trip: stop persists, new session resumes", async () => {
    const kv = makeMemoryKv();

    // Session 1: build up state and disconnect
    const p1 = makePersistence(kv);
    // Mutate the state object in-place so getState() returns updated values
    const s1State = p1.persistence.getState();
    (s1State as Record<string, unknown>).score = 100;

    const s1 = setup({ id: "sess-1", persistence: p1.persistence });
    await s1.session.start();
    s1.mockHandle._fire("ready", { sessionId: "s2s-round-trip" });
    s1.session.onHistory([{ role: "user", content: "My score is 100" }]);
    await s1.session.stop();

    // Verify session 1 was persisted
    const persistedData = await kv.get<PersistedSession>(persistKey("sess-1"));
    expect(persistedData).toEqual(
      expect.objectContaining({ state: { score: 100 }, s2sSessionId: "s2s-round-trip" }),
    );

    // Session 2: resume from session 1 (don't use setup() — manually manage mock)
    const p2 = makePersistence(kv);
    const mockHandle2 = makeMockHandle();
    connectSpy.mockResolvedValue(mockHandle2);

    const client2 = makeClient();
    const session2 = createS2sSession(
      makeSessionOpts({
        id: "sess-2",
        client: client2,
        persistence: p2.persistence,
        resumeFrom: "sess-1",
      }),
    );
    await session2.start();

    // State should be restored
    expect(p2.state).toEqual({ score: 100 });
    // S2S session should be resumed
    expect(mockHandle2.resumeSession).toHaveBeenCalledWith("s2s-round-trip");
  });
});
