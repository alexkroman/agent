// Copyright 2025 the AAI authors. MIT license.
/** Unit test for the Cartesia TTS adapter. Mocks `@cartesia/cartesia-js`. */

import { beforeEach, describe, expect, test, vi } from "vitest";
import { flush } from "../../_test-utils.ts";
import { type CartesiaSession, openCartesia } from "./cartesia.ts";

// Recorded interactions on the fake `TTSWSContext` — one entry per method call.
interface RecordedSend {
  kind: "send" | "cancel";
  contextId: string;
  transcript?: string | undefined;
  continue?: boolean | undefined;
  language?: string | undefined;
  model_id?: string | undefined;
}

const sends: RecordedSend[] = [];

/** Minimal shape of the request the adapter sends to Cartesia. */
interface FakeGenerationRequest {
  transcript: string;
  continue: boolean;
  language?: string;
  model_id?: string;
}

/**
 * Fake `TTSWSContext`. Mirrors the fields the adapter touches:
 * `contextId`, `send`, `cancel`.
 */
interface FakeContext {
  contextId: string;
  send(req: FakeGenerationRequest): Promise<void>;
  cancel(): Promise<void>;
}

/** Fake `TTSWS`. EventEmitter-ish with a `_fire` test hook. */
interface FakeTTSWS {
  contexts: FakeContext[];
  context(opts: { contextId: string }): FakeContext;
  on(event: string, fn: (...args: unknown[]) => void): FakeTTSWS;
  close(props?: { code: number; reason: string }): void;
  _fire(event: string, payload: unknown): void;
}

vi.mock("@cartesia/cartesia-js", () => {
  const makeWs = (): FakeTTSWS => {
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
      on(event, fn) {
        const arr = listeners.get(event) ?? [];
        arr.push(fn);
        listeners.set(event, arr);
        return ws;
      },
      close(_props) {
        /* no-op */
      },
      _fire(event, payload) {
        for (const fn of listeners.get(event) ?? []) fn(payload);
      },
    };
    return ws;
  };
  return {
    Cartesia: class {
      tts = {
        websocket: async () => makeWs(),
      };
    },
  };
});

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

    // All three sends for turn 1 carry the same contextId — two deltas with
    // continue: true, then an empty-transcript send with continue: false.
    const turn1Sends = sends.filter((s) => s.contextId === turn1);
    expect(turn1Sends).toEqual([
      {
        kind: "send",
        contextId: turn1,
        transcript: "hello",
        continue: true,
        language: "en",
        model_id: "sonic-2",
      },
      {
        kind: "send",
        contextId: turn1,
        transcript: " world",
        continue: true,
        language: "en",
        model_id: "sonic-2",
      },
      {
        kind: "send",
        contextId: turn1,
        transcript: "",
        continue: false,
        language: "en",
        model_id: "sonic-2",
      },
    ]);

    // Rotation is deferred until the next sendText so Cartesia's late
    // audio chunks + real `done` event (both tagged with turn1's id) still
    // pass the context-id filter.
    expect(session._currentContextId()).toBe(turn1);

    // Subsequent sendText rotates to a fresh context.
    session.sendText("next");
    const turn2 = session._currentContextId();
    expect(turn2).not.toBe(turn1);
    await flush();
    expect(sends.filter((s) => s.contextId === turn2)).toEqual([
      {
        kind: "send",
        contextId: turn2,
        transcript: "next",
        continue: true,
        language: "en",
        model_id: "sonic-2",
      },
    ]);

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

    // We expect: send("hello", continue:true) on turn1, then cancel(turn1).
    expect(sends).toEqual([
      {
        kind: "send",
        contextId: turn1,
        transcript: "hello",
        continue: true,
        language: "en",
        model_id: "sonic-2",
      },
      { kind: "cancel", contextId: turn1 },
    ]);

    // Rotation is deferred until the next sendText — cancel() halts the
    // old context on Cartesia's side, so late events for turn1 can safely
    // keep passing the filter until the next turn actually begins.
    expect(session._currentContextId()).toBe(turn1);

    // A subsequent sendText mints a fresh context for turn2.
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
});
