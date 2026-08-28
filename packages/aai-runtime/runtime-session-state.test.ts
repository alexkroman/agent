// Copyright 2026 the AAI authors. MIT license.
/**
 * Where a session picks its slot state up, and where it puts it down.
 *
 * ## What this file proves
 *
 * The two ORDERINGS `attachSessionState` exists for, which are the same two its
 * event-log twin (`runtime-session-stream.test.ts`, the file this one mirrors)
 * pins for the conversation:
 *
 * - **`hydrate` runs before the wrapped `core.start()`**, and
 *   `pushStateSnapshot` runs after the hydration and before the start. Both
 *   halves matter and neither is visible from the other's assertion: hydrating
 *   late means a tool can observe unhydrated state; pushing early means a
 *   resumed client renders EMPTY until some later tool call happens to change
 *   something, which it may never do. A rejected load takes the failure path
 *   rather than starting a session with the wrong state.
 * - **Reclamation is tied to the session's own `stop()`**, so it happens on
 *   every teardown path — the failing one included — and is guarded by
 *   `release()`, so an old session's late `stop()` cannot wipe the state a
 *   RESUMED session under the same id has already claimed.
 *
 * Plus the backend selection `createRuntimeSessionState` makes and reports, as
 * that is what the "Session mode resolved" line answers "is this agent durable"
 * with.
 *
 * ## What it deliberately does not prove
 *
 * The store's own branches — the commit point, the size cap, commit-failure
 * retry, fail-open hydration — are `session-state-store.test.ts`'s job next
 * door, and the Postgres backend behind either of them is
 * `aai-server/session-state.scenario.test.ts`'s, behind `describeWithPg`.
 * Everything here runs on the memory backend.
 *
 * Nor does it prove the grace WINDOW: `createStateSweeps` owns the timer, and
 * this file only asserts that a stop schedules (or declines to schedule) one.
 */

import type { Db } from "@alexkroman1/aai/internal";
import { describe, expect, test, vi } from "vitest";
import { makeClientSink, makeEmitter, makeLogger, makeMockCore } from "./_test-utils.ts";
import {
  attachSessionState,
  createRuntimeSessionState,
  type RuntimeSessionState,
} from "./runtime-session-state.ts";
import { createSessionEventStream } from "./session-event-stream.ts";
import {
  createMemoryStateBackend,
  createSessionStateStore,
  type SessionStateBackend,
} from "./session-state-store.ts";
import { createStateSweeps } from "./session-state-sweeps.ts";

const SID = "s-1";

/**
 * The same shape `createRuntimeSessionState` builds, over a backend the spec
 * holds — one backend for the store and the stream, as the runtime does.
 */
function makeState(backend: SessionStateBackend = createMemoryStateBackend()): {
  state: RuntimeSessionState;
  backend: SessionStateBackend;
} {
  const store = createSessionStateStore({ backend, logger: makeLogger() });
  return {
    backend,
    state: {
      store,
      stream: createSessionEventStream({ backend }),
      sweeps: createStateSweeps(store),
      describe: { backend: backend.name, durable: backend.durable },
    },
  };
}

describe("createRuntimeSessionState", () => {
  test("no database means the MEMORY backend, and it says so", () => {
    const state = createRuntimeSessionState({ db: undefined, logger: makeLogger() });

    // What an operator reads at boot: which tier this agent is in, rather than
    // inferring it from a session that forgot something.
    expect(state.describe).toEqual({ backend: "memory", durable: false });
  });

  test("a database means the durable backend", () => {
    const db: Db = { query: vi.fn(() => Promise.resolve([])) };

    const state = createRuntimeSessionState({ db, logger: makeLogger() });

    expect(state.describe).toEqual({ backend: "postgres", durable: true });
    // Selection is construction only — the table is created on first use.
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe("attachSessionState — hydration", () => {
  test("stored state is in the cache BEFORE the underlying start runs", async () => {
    const { state, backend } = makeState();
    await backend.commit(SID, new Map([["cart", '{"items":["apple"]}']]));
    let seenAtStart: unknown;
    const core = makeMockCore({
      start: vi.fn(() => {
        seenAtStart = state.store.viewFor(SID).read("cart");
        return Promise.resolve();
      }),
    });
    attachSessionState(core, {
      state,
      sessionId: SID,
      emitter: makeEmitter(makeClientSink(), { sessionId: SID }).emitter,
      release: () => true,
    });

    await core.start();

    // Inside the `session.start()` window and before the session is ready, so
    // no tool can observe a session that has not got its state back.
    expect(seenAtStart).toEqual({ items: ["apple"] });
  });

  test("the snapshot is pushed AFTER hydration and BEFORE the start", async () => {
    const { state, backend } = makeState();
    await backend.commit(SID, new Map([["cart", '{"items":["apple"]}']]));
    const order: string[] = [];
    const hadStateAtPush: boolean[] = [];
    const core = makeMockCore({
      start: vi.fn(() => {
        order.push("start");
        return Promise.resolve();
      }),
    });
    const { emitter } = makeEmitter(makeClientSink(), { sessionId: SID });
    const pushStateSnapshot = vi.fn(() => {
      order.push("push");
      hadStateAtPush.push(state.store.has(SID));
    });
    attachSessionState(core, {
      state,
      sessionId: SID,
      emitter,
      release: () => true,
      pushStateSnapshot,
    });

    await core.start();

    expect(order).toEqual(["push", "start"]);
    // The bug the ordering prevents: `pushStateSnapshot` gates on `store.has`,
    // so pushing before the load lands finds nothing, reports nothing, and
    // leaves the reconnected client rendering empty until some later tool call
    // happens to change something.
    expect(hadStateAtPush).toEqual([true]);
    expect(pushStateSnapshot).toHaveBeenCalledWith(SID, emitter);
  });

  test("a fresh session still starts, and still gets its snapshot call", async () => {
    const { state } = makeState();
    const core = makeMockCore();
    const pushStateSnapshot = vi.fn();
    attachSessionState(core, {
      state,
      sessionId: SID,
      emitter: makeEmitter(makeClientSink(), { sessionId: SID }).emitter,
      release: () => true,
      pushStateSnapshot,
    });

    await core.start();

    // `pushStateSnapshot` decides for itself that there is nothing to show — a
    // fresh session's load finds nothing, and this path is paid on every start.
    expect(pushStateSnapshot).toHaveBeenCalledTimes(1);
    expect(state.store.has(SID)).toBe(false);
  });

  test("no pushStateSnapshot is the sandbox path, and start still runs", async () => {
    const { state } = makeState();
    const startCore = vi.fn(() => Promise.resolve());
    const core = makeMockCore({ start: startCore });
    attachSessionState(core, {
      state,
      sessionId: SID,
      emitter: makeEmitter(makeClientSink(), { sessionId: SID }).emitter,
      release: () => true,
    });

    await expect(core.start()).resolves.toBeUndefined();

    expect(startCore).toHaveBeenCalledTimes(1);
  });

  test("a failing load fails the START rather than serving unhydrated state", async () => {
    const { state } = makeState({
      ...createMemoryStateBackend(),
      load: () => Promise.reject(new Error("connection terminated")),
    });
    const startCore = vi.fn(() => Promise.resolve());
    const core = makeMockCore({ start: startCore });
    const pushStateSnapshot = vi.fn();
    attachSessionState(core, {
      state,
      sessionId: SID,
      emitter: makeEmitter(makeClientSink(), { sessionId: SID }).emitter,
      release: () => true,
      pushStateSnapshot,
    });

    // The rejection takes the existing failure path, which tears the session
    // down and tells the client.
    await expect(core.start()).rejects.toThrow("connection terminated");

    expect(startCore).not.toHaveBeenCalled();
    expect(pushStateSnapshot).not.toHaveBeenCalled();
  });
});

describe("attachSessionState — reclamation", () => {
  test("stop schedules the grace-window sweep", async () => {
    const { state } = makeState();
    const schedule = vi.spyOn(state.sweeps, "schedule");
    const stopCore = vi.fn(() => Promise.resolve());
    const core = makeMockCore({ stop: stopCore });
    attachSessionState(core, {
      state,
      sessionId: SID,
      emitter: makeEmitter(makeClientSink(), { sessionId: SID }).emitter,
      release: () => true,
    });

    await core.stop();

    expect(stopCore).toHaveBeenCalledTimes(1);
    // Scheduled rather than discarded: slot state outlives the socket so a
    // `?sessionId=<id>` reconnect finds it.
    expect(schedule).toHaveBeenCalledWith(SID);
    expect(state.store.has(SID)).toBe(false);
  });

  test("a session that stopped by FAILING is still reclaimed", async () => {
    const { state } = makeState();
    const schedule = vi.spyOn(state.sweeps, "schedule");
    const core = makeMockCore({ stop: vi.fn(() => Promise.reject(new Error("provider died"))) });
    attachSessionState(core, {
      state,
      sessionId: SID,
      emitter: makeEmitter(makeClientSink(), { sessionId: SID }).emitter,
      release: () => true,
    });

    await expect(core.stop()).rejects.toThrow("provider died");

    // In the `finally`: a teardown that threw is exactly when a leaked session
    // would never be reclaimed at all.
    expect(schedule).toHaveBeenCalledWith(SID);
  });

  test("an old session's late stop does NOT wipe a resumed session's state", async () => {
    const { state } = makeState();
    const schedule = vi.spyOn(state.sweeps, "schedule");
    const core = makeMockCore();
    // `release()` is false once a resume re-claimed this id — the async stop of
    // the superseded session settles after the new one is already serving.
    attachSessionState(core, {
      state,
      sessionId: SID,
      emitter: makeEmitter(makeClientSink(), { sessionId: SID }).emitter,
      release: () => false,
    });
    state.store.viewFor(SID).write("cart", { items: ["apple"] }, true);

    await core.stop();

    expect(schedule).not.toHaveBeenCalled();
    // The resumed session's state is untouched, which is the whole point of
    // release-by-claim rather than a bare key delete.
    expect(state.store.viewFor(SID).read("cart")).toEqual({ items: ["apple"] });
  });

  test("release is consulted once per stop, after the underlying stop", async () => {
    const { state } = makeState();
    const order: string[] = [];
    const release = vi.fn(() => {
      order.push("release");
      return true;
    });
    const core = makeMockCore({
      stop: vi.fn(() => {
        order.push("stop");
        return Promise.resolve();
      }),
    });
    attachSessionState(core, {
      state,
      sessionId: SID,
      emitter: makeEmitter(makeClientSink(), { sessionId: SID }).emitter,
      release,
    });

    await core.stop();

    expect(order).toEqual(["stop", "release"]);
    expect(release).toHaveBeenCalledTimes(1);
  });
});
