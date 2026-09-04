// Copyright 2026 the AAI authors. MIT license.
/**
 * The store that makes a turn's slot state survive the process.
 *
 * ## What this file proves
 *
 * The COMMIT POINT and the four decisions around it, each of which is the
 * difference between a durable agent and one that merely looks like it:
 *
 * - a value written through a slot view reaches the backend on `flush` and NOT
 *   before, and a second store over the same backend reads it back after
 *   `hydrate` — the redeploy/crash round trip, in miniature;
 * - only what CHANGED is written (the draft model hands a new object per
 *   mutation, so the serialization is the comparison);
 * - a slot past {@link MAX_SESSION_STATE_BYTES} is refused and REPORTED while
 *   the in-memory value stays correct — a durability failure, never a
 *   correctness one;
 * - a rejecting `commit` never throws out of `flush` (it runs in a tool call's
 *   `finally`, where a throw would replace the tool's own result) and the slots
 *   go back on the dirty set, so the NEXT flush retries them;
 * - hydration is FAIL-OPEN: a row that will not parse, or one holding a shape
 *   the running code cannot store, is dropped with a warning and the session
 *   lives — which is the routine-redeploy case — while a sibling slot in the
 *   same session still hydrates;
 * - a slot already written in this process wins over the stored value;
 * - `has()`, which is what `pushStateSnapshot` gates a resumed client's first
 *   render on.
 *
 * ## What it deliberately does not prove
 *
 * **The Postgres arm.** Everything here runs over
 * {@link createMemoryStateBackend}, which is a legitimate double and not a
 * convenience: values cross the backend boundary as serialized JSON in both,
 * and the storability check (`freezeStorable`) runs in both, which is the whole
 * reason the memory backend is allowed to stand in (see the store's own module
 * doc). What it CANNOT represent is the driver: the `jsonb` column, the upsert,
 * the connection budget, `updated_at`. Those are
 * `aai-server/session-state.scenario.test.ts`'s job, behind `describeWithPg`.
 *
 * It also says nothing about WHO calls `flush` — `runtime-tools.ts` owns that
 * — nor about where a session hydrates, which is
 * `runtime-session-state.test.ts` next door.
 */

import { MAX_SESSION_STATE_BYTES } from "@alexkroman1/aai/host-internal";
import { describe, expect, test } from "vitest";
import { flush, makeLogger } from "./_test-utils.ts";
import {
  createMemoryStateBackend,
  createSessionStateStore,
  type SessionStateBackend,
} from "./session-state-store.ts";

const SID = "s-1";

/** A store over a real memory backend, plus the logger a failure is reported to. */
function makeStore(backend: SessionStateBackend = createMemoryStateBackend()) {
  const logger = makeLogger();
  return { store: createSessionStateStore({ backend, logger }), backend, logger };
}

/**
 * The memory backend, recording every `commit` it is handed.
 *
 * A wrapper rather than a replacement so the round trip still really happens —
 * "what was written" and "what is stored" have to be separately observable for
 * the write-only-what-changed rule to mean anything.
 */
function recordingBackend(): { backend: SessionStateBackend; commits: Map<string, string>[] } {
  const inner = createMemoryStateBackend();
  const commits: Map<string, string>[] = [];
  return {
    commits,
    backend: {
      ...inner,
      commit: (sessionId, values) => {
        commits.push(new Map(values));
        return inner.commit(sessionId, values);
      },
    },
  };
}

describe("the commit point", () => {
  test("a slot write reaches the backend on FLUSH, and not before", async () => {
    const { store, backend } = makeStore();

    store.viewFor(SID).write("cart", { items: ["apple"] }, true);

    // The tool call is still running: `slot.update` is synchronous and cannot
    // await a write of its own, so nothing is stored yet.
    await expect(backend.load(SID)).resolves.toEqual(new Map());

    await store.flush(SID);

    await expect(backend.load(SID)).resolves.toEqual(new Map([["cart", '{"items":["apple"]}']]));
  });

  test("a REPLACEMENT process reads back what the last one committed", async () => {
    const backend = createMemoryStateBackend();
    const before = createSessionStateStore({ backend });
    before.viewFor(SID).write("cart", { items: ["apple"], total: 1.5 }, true);
    await before.flush(SID);

    // The crash / redeploy: a new store, the same backend, nothing in its cache.
    const after = createSessionStateStore({ backend });
    expect(after.viewFor(SID).read("cart")).toBeUndefined();
    await after.hydrate(SID);

    expect(after.viewFor(SID).read("cart")).toEqual({ items: ["apple"], total: 1.5 });
  });

  test("a flush for a session that has done nothing writes nothing", async () => {
    const { backend, commits } = recordingBackend();
    const store = createSessionStateStore({ backend });

    // Every tool call flushes, and most sessions never touch a durable slot.
    await expect(store.flush(SID)).resolves.toBeUndefined();

    expect(commits).toEqual([]);
  });

  test("a VIRTUAL slot is cached and never committed", async () => {
    const { store, backend } = makeStore();
    const socket = { close: () => undefined };

    store.viewFor(SID).write("link", socket, false);
    await store.flush(SID);

    // Readable in this process — and frozen by nothing, since a virtual slot
    // holds the things that cannot be serialized in the first place.
    expect(store.viewFor(SID).read("link")).toBe(socket);
    await expect(backend.load(SID)).resolves.toEqual(new Map());
  });
});

describe("write only what CHANGED", () => {
  test("an unchanged value is not re-committed", async () => {
    const { backend, commits } = recordingBackend();
    const store = createSessionStateStore({ backend });
    const view = store.viewFor(SID);

    view.write("cart", { items: ["apple"] }, true);
    await store.flush(SID);
    // The draft model hands back a NEW object on every mutation, so identity
    // says nothing and the serialization is the comparison.
    view.write("cart", { items: ["apple"] }, true);
    await store.flush(SID);

    expect(commits).toEqual([new Map([["cart", '{"items":["apple"]}']])]);
  });

  test("only the changed slot rides along when a session holds several", async () => {
    const { backend, commits } = recordingBackend();
    const store = createSessionStateStore({ backend });
    const view = store.viewFor(SID);
    view.write("cart", { items: [] }, true);
    view.write("profile", { name: "Ada" }, true);
    await store.flush(SID);

    view.write("cart", { items: ["apple"] }, true);
    view.write("profile", { name: "Ada" }, true);
    await store.flush(SID);

    expect(commits).toHaveLength(2);
    expect([...(commits[1]?.keys() ?? [])]).toEqual(["cart"]);
  });

  test("a value that changes BACK is still written, because the store compares against what is stored", async () => {
    const { backend, commits } = recordingBackend();
    const store = createSessionStateStore({ backend });
    const view = store.viewFor(SID);
    view.write("cart", { items: [] }, true);
    await store.flush(SID);

    view.write("cart", { items: ["apple"] }, true);
    await store.flush(SID);
    view.write("cart", { items: [] }, true);
    await store.flush(SID);

    // Three commits, not two: the comparison is against the last COMMITTED
    // serialization, so a round trip back to an older value is a real write.
    expect(commits.map((c) => c.get("cart"))).toEqual([
      '{"items":[]}',
      '{"items":["apple"]}',
      '{"items":[]}',
    ]);
  });

  test("a mutation landing DURING the commit stays dirty", async () => {
    const inner = createMemoryStateBackend();
    const gate = Promise.withResolvers<void>();
    const backend: SessionStateBackend = {
      ...inner,
      commit: async (sessionId, values) => {
        await gate.promise;
        await inner.commit(sessionId, values);
      },
    };
    const store = createSessionStateStore({ backend });
    const view = store.viewFor(SID);
    view.write("cart", { items: ["first"] }, true);

    const flushing = store.flush(SID);
    // The dirty set is cleared before the await, so this write re-dirties the
    // slot rather than being swallowed by the in-flight commit.
    view.write("cart", { items: ["second"] }, true);
    gate.resolve();
    await flushing;

    await expect(inner.load(SID)).resolves.toEqual(new Map([["cart", '{"items":["first"]}']]));
    await store.flush(SID);
    await expect(inner.load(SID)).resolves.toEqual(new Map([["cart", '{"items":["second"]}']]));
  });
});

describe("the size cap", () => {
  test("a slot past the cap is NOT committed, is reported, and costs the caller nothing", async () => {
    const { store, backend, logger } = makeStore();
    const runaway = { blob: "x".repeat(MAX_SESSION_STATE_BYTES) };
    const view = store.viewFor(SID);

    view.write("transcript", runaway, true);
    view.write("cart", { items: ["apple"] }, true);
    // Never rejects: this runs in a tool call's `finally`.
    await expect(store.flush(SID)).resolves.toBeUndefined();

    const stored = await backend.load(SID);
    expect(stored.has("transcript")).toBe(false);
    // The important half — the in-memory value is still right, and the slot
    // beside it was stored, so the tool's own result is unaffected.
    expect(store.viewFor(SID).read("transcript")).toEqual(runaway);
    expect(stored.get("cart")).toBe('{"items":["apple"]}');
    expect(logger.error).toHaveBeenCalledWith("Session state too large to store", {
      sessionId: SID,
      slot: "transcript",
      // ASCII, so units and bytes agree here — which is exactly why this case
      // cannot see the bug the next one covers.
      bytes: Buffer.byteLength(JSON.stringify(runaway)),
      cap: MAX_SESSION_STATE_BYTES,
    });
  });

  test("the cap counts BYTES, not UTF-16 code units", async () => {
    // The bug this pins: `json.length > MAX_SESSION_STATE_BYTES` compared code
    // units against a byte budget, so multi-byte content passed at up to ~3x its
    // real size — a slot the cap read as under 1 MiB writing 3 MiB into the
    // tenant's own schema, with the log calling the wrong number `bytes`. Same
    // class as the one `_fetch-capped.ts` was written for.
    //
    // A third of the cap in 3-byte characters: comfortably UNDER by `length` and
    // comfortably OVER in bytes, so it passes the old comparison and fails the
    // new one. Every other case in this file is ASCII and cannot discriminate.
    const { store, backend, logger } = makeStore();
    const cjk = { blob: "あ".repeat(Math.floor(MAX_SESSION_STATE_BYTES / 2)) };
    const json = JSON.stringify(cjk);
    expect(json.length).toBeLessThan(MAX_SESSION_STATE_BYTES);
    expect(Buffer.byteLength(json)).toBeGreaterThan(MAX_SESSION_STATE_BYTES);

    store.viewFor(SID).write("transcript", cjk, true);
    await expect(store.flush(SID)).resolves.toBeUndefined();

    await expect(backend.load(SID)).resolves.toEqual(new Map());
    expect(logger.error).toHaveBeenCalledWith("Session state too large to store", {
      sessionId: SID,
      slot: "transcript",
      bytes: Buffer.byteLength(json),
      cap: MAX_SESSION_STATE_BYTES,
    });
  });

  test("a large value UNDER the cap is committed normally", async () => {
    const { store, backend, logger } = makeStore();
    // Serializes to the string plus its two quotes — comfortably inside.
    const big = "x".repeat(MAX_SESSION_STATE_BYTES - 100);

    store.viewFor(SID).write("transcript", big, true);
    await store.flush(SID);

    await expect(backend.load(SID)).resolves.toEqual(
      new Map([["transcript", JSON.stringify(big)]]),
    );
    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe("a failed commit is a DURABILITY failure", () => {
  test("flush does not reject, and the slots retry on the next flush", async () => {
    const inner = createMemoryStateBackend();
    let down = true;
    const backend: SessionStateBackend = {
      ...inner,
      commit: (sessionId, values) =>
        down ? Promise.reject(new Error("connection terminated")) : inner.commit(sessionId, values),
    };
    const { store, logger } = makeStore(backend);
    store.viewFor(SID).write("cart", { items: ["apple"] }, true);

    // A storage fault must never become the tool's result.
    await expect(store.flush(SID)).resolves.toBeUndefined();
    await expect(inner.load(SID)).resolves.toEqual(new Map());
    expect(logger.warn).toHaveBeenCalledWith("Session state not stored", {
      sessionId: SID,
      error: "connection terminated",
    });

    // The next tool call's flush, with nothing newly written: the retry can only
    // happen because the failure put the slot back on the dirty set.
    down = false;
    await store.flush(SID);

    await expect(inner.load(SID)).resolves.toEqual(new Map([["cart", '{"items":["apple"]}']]));
  });

  test("a failed commit leaves the in-memory value correct", async () => {
    const { store } = makeStore({
      ...createMemoryStateBackend(),
      commit: () => Promise.reject(new Error("connection terminated")),
    });

    store.viewFor(SID).write("cart", { items: ["apple"] }, true);
    await store.flush(SID);

    expect(store.viewFor(SID).read("cart")).toEqual({ items: ["apple"] });
    // Which is the memory tier's behaviour for as long as it lasts — the loss
    // is durability, not correctness.
    expect(store.has(SID)).toBe(true);
  });

  test("a backend that will not LOAD fails the session start", async () => {
    const { store } = makeStore({
      ...createMemoryStateBackend(),
      load: () => Promise.reject(new Error("connection terminated")),
    });

    // Unlike a commit, this one rejects: the caller turns it into a failed
    // session start rather than serving a session with the wrong state.
    await expect(store.hydrate(SID)).rejects.toThrow("connection terminated");
  });
});

describe("hydration is FAIL-OPEN", () => {
  test("a row that will not parse is dropped, and its sibling still hydrates", async () => {
    const backend = createMemoryStateBackend();
    await backend.commit(
      SID,
      new Map([
        ["cart", '{"items":["apple"]}'],
        ["legacy", "{not json"],
      ]),
    );
    const { store, logger } = makeStore(backend);

    // The session SURVIVES — refusing would mean a routine deploy drops every
    // in-flight call.
    await expect(store.hydrate(SID)).resolves.toBeUndefined();

    expect(store.viewFor(SID).read("legacy")).toBeUndefined();
    expect(store.viewFor(SID).read("cart")).toEqual({ items: ["apple"] });
    expect(logger.warn).toHaveBeenCalledWith(
      "Stored session state dropped",
      expect.objectContaining({ sessionId: SID, slot: "legacy" }),
    );
  });

  test("a row holding a shape the running code cannot store is dropped too", async () => {
    const backend = createMemoryStateBackend();
    // Parses fine and is not storable: JSON has no infinity literal, but
    // `1e999` reads back as `Infinity`, which JSON would store as null. Reachable
    // from a hand-edited row, which is exactly what fail-open is for.
    await backend.commit(
      SID,
      new Map([
        ["ledger", '{"total":1e999}'],
        ["cart", '{"items":[]}'],
      ]),
    );
    const { store, logger } = makeStore(backend);

    await store.hydrate(SID);

    expect(store.viewFor(SID).read("ledger")).toBeUndefined();
    expect(store.viewFor(SID).read("cart")).toEqual({ items: [] });
    expect(logger.warn).toHaveBeenCalledWith(
      "Stored session state dropped",
      expect.objectContaining({ slot: "ledger" }),
    );
  });

  test("a hydrated value is FROZEN, exactly as a write would be", async () => {
    const backend = createMemoryStateBackend();
    await backend.commit(SID, new Map([["cart", '{"items":["apple"]}']]));
    const { store } = makeStore(backend);
    await store.hydrate(SID);

    const cart = store.viewFor(SID).read("cart");

    // A hydrated value is handed to the same `get` and must behave the same:
    // a mutation applied here is applied to something nothing will store.
    expect(Object.isFrozen(cart)).toBe(true);
  });

  test("a hydrated value is not re-committed by the next flush", async () => {
    const { backend, commits } = recordingBackend();
    await backend.commit(SID, new Map([["cart", '{"items":["apple"]}']]));
    commits.length = 0;
    const store = createSessionStateStore({ backend });

    await store.hydrate(SID);
    await store.flush(SID);

    expect(commits).toEqual([]);
  });

  test("hydration does not clobber a live write", async () => {
    const backend = createMemoryStateBackend();
    await backend.commit(SID, new Map([["cart", '{"items":["stored"]}']]));
    const { store } = makeStore(backend);

    // Hydration runs before the session is ready, but a direct caller could
    // already have touched the slot — and the live value is the newer one.
    store.viewFor(SID).write("cart", { items: ["live"] }, true);
    await store.hydrate(SID);

    expect(store.viewFor(SID).read("cart")).toEqual({ items: ["live"] });
  });

  test("a fresh session hydrates nothing and creates no entry", async () => {
    const { store } = makeStore();

    await store.hydrate(SID);

    expect(store.has(SID)).toBe(false);
  });
});

describe("has()", () => {
  test("false for a session that has done nothing", () => {
    const { store } = makeStore();

    expect(store.has(SID)).toBe(false);
  });

  test("true once a slot is written", () => {
    const { store } = makeStore();

    store.viewFor(SID).write("cart", { items: [] }, true);

    // What `pushStateSnapshot` gates on: a brand-new session has nothing to
    // show, and this is the line between the two.
    expect(store.has(SID)).toBe(true);
  });

  test("true once a stored slot is hydrated", async () => {
    const backend = createMemoryStateBackend();
    await backend.commit(SID, new Map([["cart", '{"items":[]}']]));
    const { store } = makeStore(backend);

    expect(store.has(SID)).toBe(false);
    await store.hydrate(SID);

    expect(store.has(SID)).toBe(true);
  });

  test("stays false when every stored row was dropped", async () => {
    const backend = createMemoryStateBackend();
    await backend.commit(SID, new Map([["legacy", "{not json"]]));
    const { store } = makeStore(backend);

    await store.hydrate(SID);

    // Nothing hydrated, so there is nothing to snapshot to the resumed client.
    expect(store.has(SID)).toBe(false);
  });
});

describe("reclamation", () => {
  test("discard drops the cache entry AND the stored rows", async () => {
    const { store, backend } = makeStore();
    store.viewFor(SID).write("cart", { items: ["apple"] }, true);
    await store.flush(SID);

    store.discard(SID);

    expect(store.has(SID)).toBe(false);
    // Awaited by nobody in production — the caller is a grace-window sweep —
    // so the assertion has to wait for the fire-and-forget to settle.
    await expect(backend.load(SID)).resolves.toEqual(new Map());
  });

  test("a failing discard is logged rather than thrown at the sweep", async () => {
    const { store, logger } = makeStore({
      ...createMemoryStateBackend(),
      discard: () => Promise.reject(new Error("connection terminated")),
    });
    store.viewFor(SID).write("cart", { items: [] }, true);

    expect(() => store.discard(SID)).not.toThrow();

    // Fire-and-forget, so the rejection is handled a microtask later.
    await flush();
    expect(logger.warn).toHaveBeenCalledWith(
      "Session state not reclaimed",
      expect.objectContaining({ sessionId: SID }),
    );
  });

  test("clear drops every cache entry and leaves the rows alone", async () => {
    const { store, backend } = makeStore();
    store.viewFor(SID).write("cart", { items: ["apple"] }, true);
    await store.flush(SID);

    store.clear();

    expect(store.has(SID)).toBe(false);
    // Runtime shutdown is not the end of the session's durability.
    await expect(backend.load(SID)).resolves.toEqual(new Map([["cart", '{"items":["apple"]}']]));
  });
});
