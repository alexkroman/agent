// Copyright 2026 the AAI authors. MIT license.

import type { Db, SessionEventHandlers, SlotStore } from "@alexkroman1/aai";
import { createDetachedSlotStore } from "@alexkroman1/aai/host-internal";
import type { ClientSink, SessionEvent } from "@alexkroman1/aai/protocol";
import { createUnusedDb } from "@alexkroman1/aai/testing";
import { omitUndefined } from "@alexkroman1/aai/utils";
import { describe, expect, test, vi } from "vitest";
import { makeLogger } from "./_test-utils.ts";
import { createSessionEmitter } from "./session-emitter.ts";
import { createSessionEventStream } from "./session-event-stream.ts";
import { createMemoryStateBackend } from "./session-state-store.ts";

const SID = "s-1";

/**
 * A db handle no case here dials — `ctx.db` in a hook is a handle, not a query.
 *
 * The SDK's own published helper rather than a cast object: it REJECTS naming
 * itself, so a hook that unexpectedly queried would say so.
 */
const UNUSED_DB: Db = createUnusedDb();

/**
 * A hook context's `slots`, per case.
 *
 * Detached rather than a runtime state store: these cases assert what the emitter
 * DOES with a write (commit it, once, and only when one happened), and the store's
 * own commit semantics are `session-state-store.test.ts`'s subject.
 */
const slotsFor = () => createDetachedSlotStore();

function setup(opts?: {
  handlers?: SessionEventHandlers;
  db?: () => Db;
  slots?: SlotStore;
  commit?: () => void;
}) {
  const events: SessionEvent[] = [];
  const client: ClientSink = {
    open: true,
    event: vi.fn((e: SessionEvent) => events.push(e)),
    playAudioChunk: vi.fn(),
  };
  const stream = createSessionEventStream({ backend: createMemoryStateBackend() });
  const logger = makeLogger();
  const slots = opts?.slots ?? slotsFor();
  const emitter = createSessionEmitter({
    sessionId: SID,
    client,
    stream,
    logger,
    ...omitUndefined({ commit: opts?.commit }),
    ...(opts?.handlers
      ? {
          hooks: {
            handlers: opts.handlers,
            env: { MY_KEY: "v" },
            slots,
            db: opts.db ?? (() => UNUSED_DB),
          },
        }
      : {}),
  });
  return { emitter, client, events, stream, logger, slots };
}

describe("session emitter", () => {
  test("records, then sends, and returns the stamped event", async () => {
    const { emitter, events, stream } = setup();

    const event = emitter.emit({ type: "speech.started" });

    expect(events).toEqual([event]);
    // Recorded FIRST, so nothing downstream can observe an event the log lacks.
    const page = await stream.read(SID, 0);
    expect(page.events).toEqual([event]);
  });

  test("a send that throws does not stop the event being recorded or hooked", async () => {
    const seen: string[] = [];
    // Only the stream and the logger: `setup`'s own emitter is never emitted
    // through here, and building it WITH handlers made the `seen` assertion
    // below readable as a claim about it — it is satisfied entirely by `boom`'s
    // handler, which is the one under test.
    const { stream, logger } = setup();
    const boom = createSessionEmitter({
      sessionId: SID,
      client: {
        open: true,
        event: () => {
          throw new Error("socket closed");
        },
        playAudioChunk: vi.fn(),
      },
      stream,
      logger,
      hooks: {
        handlers: { "*": (e) => seen.push(e.type) },
        env: {},
        slots: slotsFor(),
        db: () => UNUSED_DB,
      },
    });

    expect(() => boom.emit({ type: "speech.started" })).not.toThrow();

    // The event HAPPENED whether or not the client heard about it — an emit is
    // called from transport dispatch with no try/catch above it.
    await expect(stream.read(SID, 0)).resolves.toMatchObject({ tail: 1 });
    expect(seen).toEqual(["speech.started"]);
    expect(logger.warn).toHaveBeenCalledWith(
      "Session event not delivered",
      expect.objectContaining({ type: "speech.started" }),
    );
  });
});

describe("session event hooks", () => {
  test("a typed handler receives its own event, and only its own", () => {
    const calls: string[] = [];
    const { emitter } = setup({
      handlers: {
        "tool.called": (e) => calls.push(`tool:${e.toolName}`),
        "speech.started": () => calls.push("speech"),
      },
    });

    emitter.emit({ type: "tool.called", toolCallId: "c1", toolName: "search", args: {} });
    emitter.emit({ type: "reply.completed" });

    expect(calls).toEqual(["tool:search"]);
  });

  test("the typed handler runs BEFORE the wildcard", () => {
    const order: string[] = [];
    const { emitter } = setup({
      handlers: {
        "speech.started": () => order.push("typed"),
        "*": () => order.push("wildcard"),
      },
    });

    emitter.emit({ type: "speech.started" });

    expect(order).toEqual(["typed", "wildcard"]);
  });

  test("the wildcard sees every event", () => {
    const seen: string[] = [];
    const { emitter } = setup({ handlers: { "*": (e) => seen.push(e.type) } });

    emitter.emit({ type: "speech.started" });
    emitter.emit({ type: "reply.completed" });

    expect(seen).toEqual(["speech.started", "reply.completed"]);
  });

  test("hooks run AFTER the client has been sent the frame", () => {
    const order: string[] = [];
    const stream = createSessionEventStream({ backend: createMemoryStateBackend() });
    const emitter = createSessionEmitter({
      sessionId: SID,
      client: { open: true, event: () => order.push("client"), playAudioChunk: vi.fn() },
      stream,
      hooks: {
        handlers: { "*": () => order.push("hook") },
        env: {},
        slots: slotsFor(),
        db: () => UNUSED_DB,
      },
    });

    emitter.emit({ type: "speech.started" });

    // A slow or throwing hook must not delay a caption or a turn boundary on a
    // live call.
    expect(order).toEqual(["client", "hook"]);
  });

  test("a throwing handler is NON-FATAL and does not suppress the other", () => {
    const seen: string[] = [];
    const { emitter, logger } = setup({
      handlers: {
        "speech.started": () => {
          throw new Error("audit backend down");
        },
        "*": (e) => seen.push(e.type),
      },
    });

    // A failing audit hook must not end a phone call.
    expect(() => emitter.emit({ type: "speech.started" })).not.toThrow();
    // The two are independent declarations, so one breaking does not silence the
    // other.
    expect(seen).toEqual(["speech.started"]);
    expect(logger.warn).toHaveBeenCalledWith(
      "Session event hook failed",
      expect.objectContaining({ type: "speech.started" }),
    );
  });

  test("a rejecting async handler is caught off the promise", async () => {
    const { emitter, logger } = setup({
      handlers: { "*": () => Promise.reject(new Error("write failed")) },
    });

    emitter.emit({ type: "speech.started" });

    // Not awaited (the caller is mid-turn), so the rejection has to be caught
    // where it lands or it is an unhandled rejection that can take the host down.
    await vi.waitFor(() =>
      expect(logger.warn).toHaveBeenCalledWith(
        "Session event hook failed",
        expect.objectContaining({ type: "speech.started" }),
      ),
    );
  });

  test("the context carries the session id, the agent env and the db", () => {
    const seen: { sessionId: string; env: unknown; db: unknown }[] = [];
    const { emitter } = setup({
      handlers: {
        "*": (_e, ctx) => seen.push({ sessionId: ctx.sessionId, env: ctx.env, db: ctx.db }),
      },
    });

    emitter.emit({ type: "speech.started" });

    expect(seen).toEqual([{ sessionId: SID, env: { MY_KEY: "v" }, db: UNUSED_DB }]);
  });

  test("the id is stable, so a handler can key on it", () => {
    const ids: string[] = [];
    const { emitter, events } = setup({ handlers: { "*": (e) => ids.push(e.meta.id) } });

    emitter.emit({ type: "speech.started" });

    // The same id the client got and the same one a stream read returns — which
    // is what makes ingestion idempotent against re-delivery.
    expect(ids).toEqual([events[0]?.meta.id]);
  });

  test("a hook on an agent with NO storage still runs", () => {
    const seen: string[] = [];
    const { emitter } = setup({
      handlers: { "*": (e) => seen.push(e.type) },
      db: () => {
        throw new Error("Storage is not enabled for this app");
      },
    });

    emitter.emit({ type: "speech.started" });

    // `ctx.db` is a getter, so a handler that never reads it never resolves it.
    // Built eagerly, this handler did not run at all — and hooks are useful
    // without storage (a log line, a metric), so that was exactly backwards.
    expect(seen).toEqual(["speech.started"]);
  });

  test("a hook that READS ctx.db without storage fails alone, non-fatally", () => {
    const seen: string[] = [];
    const { emitter, logger } = setup({
      handlers: {
        "speech.started": (_e, ctx) => {
          void ctx.db;
        },
        "*": (e) => seen.push(e.type),
      },
      db: () => {
        throw new Error("Storage is not enabled for this app");
      },
    });

    expect(() => emitter.emit({ type: "speech.started" })).not.toThrow();

    // The throw is the enablement guidance, caught per handler — so the other
    // handler is untouched.
    expect(seen).toEqual(["speech.started"]);
    expect(logger.warn).toHaveBeenCalledWith(
      "Session event hook failed",
      expect.objectContaining({ type: "speech.started" }),
    );
  });

  test("a hook that writes a slot gets one commit; one that only reads gets none", () => {
    const commit = vi.fn();
    const read = setup({
      handlers: { "speech.started": (_e, ctx) => ctx.slots.read("k") },
      commit,
    });
    read.emitter.emit({ type: "speech.started" });
    // The commit is a backend round trip, so it is paid by a batch that WROTE
    // and by no other — the overwhelming majority of hooks log a line.
    expect(commit).not.toHaveBeenCalled();

    const wrote = setup({
      handlers: { "speech.started": (_e, ctx) => ctx.slots.write("k", 1, true) },
      commit,
    });
    wrote.emitter.emit({ type: "speech.started" });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(wrote.slots.read("k")).toBe(1);
  });

  test("a hook's write reaches the SAME store a tool call reads", () => {
    const slots = slotsFor();
    const { emitter } = setup({
      handlers: { "user-transcript.committed": (e, ctx) => ctx.slots.write("last", e.text, true) },
      slots,
    });

    emitter.emit({ type: "user-transcript.committed", text: "go north" });

    // The point of the whole capability: a tool body reading this slot next turn
    // sees what the hook recorded, with no model cooperation in between.
    expect(slots.read("last")).toBe("go north");
  });

  test("the event a commit emits does not re-enter the hooks", () => {
    const seen: string[] = [];
    let emitter!: ReturnType<typeof setup>["emitter"];
    const commit = vi.fn(() => {
      // What `commitSessionState` really does: push the projection, which is an
      // emit of its own.
      emitter.emit({ type: "state.updated", state: { n: 1 } });
    });
    const built = setup({
      handlers: {
        "*": (e, ctx) => {
          seen.push(e.type);
          ctx.slots.write("k", seen.length, true);
        },
      },
      commit,
    });
    emitter = built.emitter;

    emitter.emit({ type: "speech.started" });

    // Without the guard this recurses until the stack gives out: the handler
    // writes, the commit emits `state.updated`, the handler writes again.
    expect(seen).toEqual(["speech.started"]);
    expect(commit).toHaveBeenCalledTimes(1);
    // The nested event is still RECORDED and sent — it happened. What it does
    // not do is announce itself.
    expect(built.events.map((e) => e.type)).toEqual(["speech.started", "state.updated"]);
  });

  test("an async hook that writes after awaiting still commits", async () => {
    const commit = vi.fn();
    const { emitter, slots } = setup({
      handlers: {
        "speech.started": async (_e, ctx) => {
          await Promise.resolve();
          ctx.slots.write("late", true, true);
        },
      },
      commit,
    });

    emitter.emit({ type: "speech.started" });
    // Nothing was written during the synchronous pass, so nothing was committed
    // yet — the handler had not reached its write.
    expect(commit).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
    expect(slots.read("late")).toBe(true);
  });

  test("a hook that writes synchronously AND after an await commits both", async () => {
    const commit = vi.fn();
    const { emitter, slots } = setup({
      handlers: {
        "speech.started": async (_e, ctx) => {
          ctx.slots.write("early", 1, true);
          await Promise.resolve();
          ctx.slots.write("late", 2, true);
        },
      },
      commit,
    });

    emitter.emit({ type: "speech.started" });
    expect(commit).toHaveBeenCalledTimes(1);

    // The regression a boolean latch produced: the deferred commit compares
    // before against after, and a flag already `true` from the synchronous pass
    // compares equal to itself — so the second write was never committed. This
    // is why `watchWrites` counts.
    await vi.waitFor(() => expect(commit).toHaveBeenCalledTimes(2));
    expect(slots.read("late")).toBe(2);
  });

  test("an agent that declares no handlers pays nothing", () => {
    const db = vi.fn(() => UNUSED_DB);
    const stream = createSessionEventStream({ backend: createMemoryStateBackend() });
    const emitter = createSessionEmitter({
      sessionId: SID,
      client: { open: true, event: vi.fn(), playAudioChunk: vi.fn() },
      stream,
      hooks: { env: {}, slots: slotsFor(), db },
    });

    emitter.emit({ type: "speech.started" });

    // The thunk is why: an agent with no hooks must not resolve a database on
    // every event it emits.
    expect(db).not.toHaveBeenCalled();
  });
});
