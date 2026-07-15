// Copyright 2025 the AAI authors. MIT license.

import { beforeEach, describe, expect, test, vi } from "vitest";
import { flush } from "../../_test-utils.ts";
import { type CartesiaSession, openCartesia } from "./cartesia.ts";

interface RecordedSend {
  kind: "send" | "cancel";
  contextId: string;
  transcript?: string | undefined;
  continue?: boolean | undefined;
  language?: string | undefined;
  model_id?: string | undefined;
}

const sends: RecordedSend[] = [];

interface FakeGenerationRequest {
  transcript: string;
  continue: boolean;
  language?: string;
  model_id?: string;
}

interface FakeContext {
  contextId: string;
  send(req: FakeGenerationRequest): Promise<void>;
  cancel(): Promise<void>;
}

interface FakeTTSWS {
  contexts: FakeContext[];
  context(opts: { contextId: string }): FakeContext;
  connect(): Promise<FakeTTSWS>;
  on(event: string, fn: (...args: unknown[]) => void): FakeTTSWS;
  close(props?: { code: number; reason: string }): void;
  _fire(event: string, payload: unknown): void;
}

// `Cartesia` only needs to be constructable now: production builds the socket
// via `new TTSWS(client)` (mocked below) rather than `client.tts.websocket()`,
// so it can bind an `error` listener before connecting.
vi.mock("@cartesia/cartesia-js", () => ({
  Cartesia: class {},
}));

vi.mock("@cartesia/cartesia-js/resources/tts/ws", () => {
  function makeWs(): FakeTTSWS {
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    const ws: FakeTTSWS = {
      contexts: [],
      context(opts) {
        const ctx: FakeContext = {
          contextId: opts.contextId,
          async send(req) {
            sends.push({
              kind: "send",
              contextId: ctx.contextId,
              transcript: req.transcript,
              continue: req.continue,
              language: req.language,
              model_id: req.model_id,
            });
          },
          async cancel() {
            sends.push({ kind: "cancel", contextId: ctx.contextId });
          },
        };
        ws.contexts.push(ctx);
        return ctx;
      },
      async connect() {
        return ws;
      },
      on(event, fn) {
        const arr = listeners.get(event) ?? [];
        arr.push(fn);
        listeners.set(event, arr);
        return ws;
      },
      close() {
        /* no-op */
      },
      _fire(event, payload) {
        for (const fn of listeners.get(event) ?? []) fn(payload);
      },
    };
    return ws;
  }
  return {
    // Production does `new TTSWS(client)`, so the mock presents the fake socket
    // as the constructed instance.
    TTSWS: class {
      constructor() {
        Object.assign(this, makeWs());
      }
    },
  };
});

function expectedSend(contextId: string, transcript: string, cont: boolean): RecordedSend {
  return {
    kind: "send",
    contextId,
    transcript,
    continue: cont,
    language: "en",
    model_id: "sonic-2",
  };
}

beforeEach(() => {
  sends.length = 0;
});

async function openSession(): Promise<{
  session: CartesiaSession;
  controller: AbortController;
}> {
  const provider = openCartesia({ voice: "voice-id" });
  const controller = new AbortController();
  const session = (await provider.open({
    sampleRate: 16_000,
    apiKey: "k",
    signal: controller.signal,
  })) as CartesiaSession;
  return { session, controller };
}

describe("cartesia TTS adapter", () => {
  test("sendText deltas share one contextId; flush ends the turn; next turn uses a fresh contextId", async () => {
    const { session, controller } = await openSession();
    const turn1 = session._currentContextId();

    session.sendText("hello");
    session.sendText(" world");
    session.flush();
    await flush();

    const turn1Sends = sends.filter((s) => s.contextId === turn1);
    expect(turn1Sends).toEqual([
      expectedSend(turn1, "hello", true),
      expectedSend(turn1, " world", true),
      expectedSend(turn1, "", false),
    ]);

    // Rotation is deferred until the next sendText so Cartesia's late
    // audio chunks + real `done` event (both tagged with turn1's id) still
    // pass the context-id filter.
    expect(session._currentContextId()).toBe(turn1);

    session.sendText("next");
    const turn2 = session._currentContextId();
    expect(turn2).not.toBe(turn1);
    await flush();
    expect(sends.filter((s) => s.contextId === turn2)).toEqual([expectedSend(turn2, "next", true)]);

    controller.abort();
    await session.close();
  });

  test("cancel() calls ws.cancelContext(contextId) and emits `done` synchronously", async () => {
    const { session, controller } = await openSession();
    const turn1 = session._currentContextId();

    const doneEvents: number[] = [];
    session.on("done", () => doneEvents.push(Date.now()));

    session.sendText("hello");
    // cancel() must emit `done` synchronously — the orchestrator advances
    // state on `done`, and barge-in response cannot be microtask-deferred.
    session.cancel();
    expect(doneEvents.length).toBe(1);

    await flush();

    expect(sends).toEqual([
      expectedSend(turn1, "hello", true),
      { kind: "cancel", contextId: turn1 },
    ]);

    // Rotation is deferred until the next sendText — cancel() halts the
    // old context on Cartesia's side, so late events for turn1 can safely
    // keep passing the filter until the next turn actually begins.
    expect(session._currentContextId()).toBe(turn1);

    session.sendText("again");
    const turn2 = session._currentContextId();
    expect(turn2).not.toBe(turn1);

    controller.abort();
    await session.close();
  });

  test("cancel() after done is a no-op on the wire (avoids Cartesia's 'context ID does not exist' 400)", async () => {
    const { session, controller } = await openSession();
    const turn1 = session._currentContextId();

    session.sendText("hello");
    session.flush();
    await flush();

    // Cartesia finishes synthesizing and emits `done` for the flushed context.
    const ws = session._ws as unknown as { _fire(event: string, payload: unknown): void };
    ws._fire("done", { context_id: turn1 });

    // A late cancel (e.g. client `cancel` event after the turn completed
    // normally) must not re-send `context.cancel()` — doing so would trip
    // Cartesia's 400 and kill the session via onTtsError → terminate.
    session.cancel();
    await flush();

    const cancels = sends.filter((s) => s.kind === "cancel");
    expect(cancels).toEqual([]);

    controller.abort();
    await session.close();
  });

  test("double cancel() only sends one wire cancel", async () => {
    const { session, controller } = await openSession();
    const turn1 = session._currentContextId();

    session.sendText("hello");
    session.cancel();
    session.cancel();
    await flush();

    const cancels = sends.filter((s) => s.kind === "cancel");
    expect(cancels).toEqual([{ kind: "cancel", contextId: turn1 }]);

    controller.abort();
    await session.close();
  });

  test("a dead-context error frame is dropped, not surfaced as a fatal error", async () => {
    const { session, controller } = await openSession();
    const turn1 = session._currentContextId();

    const errors: string[] = [];
    session.on("error", (e) => errors.push(e.code));

    // Cartesia's per-context 400 for a cancelled/retired context (its `done`
    // raced our `cancel` on the wire). Must not become a fatal tts_stream_error.
    const ws = session._ws as unknown as { _fire(event: string, payload: unknown): void };
    ws._fire(
      "error",
      new Error(
        JSON.stringify({
          context_id: turn1,
          done: true,
          message: "The requested context ID does not exist or may have already been cancelled.",
          status_code: 400,
          title: "Invalid context ID",
          type: "error",
        }),
      ),
    );
    await flush();

    expect(errors).toEqual([]);
    // Session stays usable: a subsequent turn still sends.
    session.sendText("still here");
    await flush();
    expect(sends.some((s) => s.transcript === "still here")).toBe(true);

    controller.abort();
    await session.close();
  });

  test("a genuine socket error (no context_id) still surfaces as tts_stream_error", async () => {
    const { session, controller } = await openSession();

    const errors: string[] = [];
    session.on("error", (e) => errors.push(e.code));

    const ws = session._ws as unknown as { _fire(event: string, payload: unknown): void };
    ws._fire("error", new Error("connection reset by peer"));
    await flush();

    expect(errors).toEqual(["tts_stream_error"]);

    controller.abort();
    await session.close();
  });
});
