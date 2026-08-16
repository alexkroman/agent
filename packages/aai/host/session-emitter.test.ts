// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import type { Db } from "../sdk/db.ts";
import type { ClientSink, SessionEvent } from "../sdk/protocol.ts";
import type { SessionEventHandlers } from "../sdk/session-events.ts";
import { createUnusedDb } from "../sdk/testing.ts";
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

function setup(opts?: { handlers?: SessionEventHandlers; db?: () => Db }) {
  const events: SessionEvent[] = [];
  const client: ClientSink = {
    open: true,
    event: vi.fn((e: SessionEvent) => events.push(e)),
    playAudioChunk: vi.fn(),
  };
  const stream = createSessionEventStream({ backend: createMemoryStateBackend() });
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const emitter = createSessionEmitter({
    sessionId: SID,
    client,
    stream,
    logger,
    ...(opts?.handlers
      ? {
          hooks: {
            handlers: opts.handlers,
            env: { MY_KEY: "v" },
            db: opts.db ?? (() => UNUSED_DB),
          },
        }
      : {}),
  });
  return { emitter, client, events, stream, logger };
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
      hooks: { handlers: { "*": (e) => seen.push(e.type) }, env: {}, db: () => UNUSED_DB },
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
      hooks: { handlers: { "*": () => order.push("hook") }, env: {}, db: () => UNUSED_DB },
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

  test("an agent that declares no handlers pays nothing", () => {
    const db = vi.fn(() => UNUSED_DB);
    const stream = createSessionEventStream({ backend: createMemoryStateBackend() });
    const emitter = createSessionEmitter({
      sessionId: SID,
      client: { open: true, event: vi.fn(), playAudioChunk: vi.fn() },
      stream,
      hooks: { env: {}, db },
    });

    emitter.emit({ type: "speech.started" });

    // The thunk is why: an agent with no hooks must not resolve a database on
    // every event it emits.
    expect(db).not.toHaveBeenCalled();
  });
});
