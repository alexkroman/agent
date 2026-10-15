// Copyright 2026 the AAI authors. MIT license.
// The turn gate and the stream-error guard in isolation. What they mean for the
// browser is covered end-to-end in studio/chat.test.ts, through the real HTTP
// surface; these pin the two pieces whose failure modes are invisible from
// outside — a gate freed by the wrong turn's cleanup, and a source error that
// has to become a chunk rather than an error.

import type { ServerResponse } from "node:http";
import type { UIMessage, UIMessageChunk } from "ai";
import { describe, expect, test } from "vitest";
import { createTurnGate, deliverTurn } from "./turn-stream.ts";

// The gate is observed through `enter()` alone: a `busy` reader existed once
// and no production code ever read it, so these assertions were its only
// consumers — a test affordance in the shape of an API. `enter() === null` is
// the same question, asked the way the two real callers ask it.
describe("createTurnGate", () => {
  test("admits one turn and refuses the next", () => {
    const gate = createTurnGate();
    expect(gate.enter()).not.toBeNull();
    expect(gate.enter()).toBeNull();
  });

  test("reopens on release", () => {
    const gate = createTurnGate();
    gate.enter()?.();
    expect(gate.enter()).not.toBeNull();
  });

  test("a stale release cannot free the turn that replaced it", () => {
    // Every release runs after awaits (a settled stream, a closed response), by
    // which point the gate may hold a later turn.
    const gate = createTurnGate();
    const first = gate.enter();
    first?.();
    const second = gate.enter();
    expect(second).not.toBeNull();
    first?.();
    expect(gate.enter()).toBeNull();
    second?.();
    expect(gate.enter()).not.toBeNull();
  });

  test("release is idempotent — both the response close and the turn settle call it", () => {
    const gate = createTurnGate();
    const release = gate.enter();
    release?.();
    release?.();
    expect(gate.enter()).not.toBeNull();
  });
});

/** Minimal ServerResponse the AI SDK's writer is happy with. */
function fakeResponse(): { res: ServerResponse; body: () => string } {
  const written: string[] = [];
  const decoder = new TextDecoder();
  const res = {
    setHeaders: () => res,
    writeHead: () => res,
    write: (chunk: Uint8Array) => {
      written.push(decoder.decode(chunk));
      return true;
    },
    end: () => undefined,
    on: () => res,
    once: () => res,
  };
  return { res: res as unknown as ServerResponse, body: () => written.join("") };
}

describe("deliverTurn", () => {
  const message: UIMessage = { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] };

  function fakeResult(stream: ReadableStream<UIMessageChunk>) {
    const seen: { generateMessageId?: (() => string) | undefined } = {};
    return {
      seen,
      result: {
        toUIMessageStream(options: { generateMessageId?: () => string }) {
          seen.generateMessageId = options.generateMessageId;
          return stream;
        },
        consumeStream: () => Promise.resolve(),
      },
    };
  }

  test("writes the stream and reports no failure", async () => {
    const { res, body } = fakeResponse();
    const { result } = fakeResult(
      new ReadableStream<UIMessageChunk>({
        start(c) {
          c.enqueue({ type: "text-delta", id: "t", delta: "done" } as UIMessageChunk);
          c.close();
        },
      }),
    );
    const out = await deliverTurn(result, res, {
      headers: {},
      originalMessages: [message],
      onFinish: () => undefined,
      toErrorText: String,
    });
    expect(out.failure).toBeUndefined();
    expect(body()).toContain('"delta":"done"');
  });

  test("always supplies a message id generator", async () => {
    // Without one the SDK persists the assistant message as id "".
    const { res } = fakeResponse();
    const { result, seen } = fakeResult(
      new ReadableStream<UIMessageChunk>({
        start(c) {
          c.close();
        },
      }),
    );
    await deliverTurn(result, res, {
      headers: {},
      originalMessages: [message],
      onFinish: () => undefined,
      toErrorText: String,
    });
    expect(seen.generateMessageId).toBeTypeOf("function");
    expect(seen.generateMessageId?.()).not.toBe("");
  });

  test("a broken stream reaches the client as an error frame AND is reported", async () => {
    const { res, body } = fakeResponse();
    let pulls = 0;
    const { result } = fakeResult(
      new ReadableStream<UIMessageChunk>({
        pull(c) {
          pulls += 1;
          if (pulls === 1) {
            c.enqueue({ type: "text-delta", id: "t", delta: "half" } as UIMessageChunk);
            return;
          }
          c.error(new Error("stream broke"));
        },
      }),
    );
    const out = await deliverTurn(result, res, {
      headers: {},
      originalMessages: [message],
      onFinish: () => undefined,
      toErrorText: (e) => (e as Error).message,
    });
    // The deltas already sent survive, and the error is the LAST frame: the
    // response is ended by then, so it travels in the stream or not at all.
    const frames = body()
      .split("\n\n")
      .filter((f) => f.startsWith("data: ") && f !== "data: [DONE]")
      .map((f) => JSON.parse(f.slice("data: ".length)) as UIMessageChunk);
    expect(frames).toEqual([
      { type: "text-delta", id: "t", delta: "half" },
      { type: "error", errorText: "stream broke" },
    ]);
    expect((out.failure as Error).message).toBe("stream broke");
  });
});
