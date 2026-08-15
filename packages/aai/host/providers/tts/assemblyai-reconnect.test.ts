// Copyright 2026 the AAI authors. MIT license.
// AssemblyAI TTS cancel()/reconnect specs — split from assemblyai.test.ts
// for file length. The protocol has no discard/cancel frame, so a mid-turn
// cancel drops the connection and reconnects; see the adapter's module doc.

import { beforeEach, describe, expect, test, vi } from "vitest";
import { TTS_RECONNECT_TIMEOUT_MS } from "../../../sdk/constants.ts";
import type { TtsError } from "../../../sdk/providers.ts";
import { tick } from "../../_test-utils.ts";
import { WS_OPEN_TIMEOUT_MS } from "../_socket.ts";
import { FakeWebSocket, pcmBase64 } from "./_assemblyai-fake-ws-test-utils.ts";
import { openSession } from "./_assemblyai-session-test-utils.ts";
import { openAssemblyAITts } from "./assemblyai.ts";

// Async factory importing an import-free module: the adapter's own "ws"
// import must not be reachable from the factory (it would re-enter the mock).
vi.mock("ws", async () => {
  const { FakeWebSocket } = await import("./_assemblyai-fake-ws-test-utils.ts");
  return { default: FakeWebSocket, WebSocket: FakeWebSocket };
});

beforeEach(() => {
  FakeWebSocket.reset();
});

describe("AssemblyAI TTS cancel() reconnect", () => {
  // The protocol has no discard/cancel frame, so a mid-turn cancel must drop
  // the connection (and with it the server-side text buffer + in-flight
  // audio) and reconnect — see the module doc.

  test("cancel mid-turn drops the socket and reconnects", async () => {
    const { session, ws } = await openSession();
    session.sendText("half a reply");
    session.cancel();
    expect(ws.readyState).toBe(FakeWebSocket.CLOSED);
    await tick();
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(session._ws).not.toBe(ws);
  });

  test("cancel with no turn in flight keeps the socket (and is idempotent)", async () => {
    const { session, ws } = await openSession();
    session.cancel();
    expect(ws.readyState).toBe(FakeWebSocket.OPEN);

    session.sendText("hi");
    session.cancel();
    session.cancel(); // second cancel of the same turn: no second reconnect
    await tick();
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  test("stale frames from the cancelled socket are unobservable", async () => {
    const { session, ws } = await openSession();
    const events: string[] = [];
    session.on("audio", () => events.push("audio"));
    session.on("done", () => events.push("done"));
    session.on("error", () => events.push("error"));

    session.sendText("cancelled reply");
    session.cancel(); // synchronous barge-in done; no tts_stream_error from the close
    expect(events).toEqual(["done"]);

    await tick();
    // Audio/done/error already in flight from the old socket must be dropped.
    ws._msg({ type: "Audio", audio: pcmBase64([1, 2]) });
    ws._msg({ type: "FlushDone" });
    ws._fire("error", new Error("late"));
    expect(events).toEqual(["done"]);
  });

  test("a late old-turn done cannot end the next turn early", async () => {
    // sendText resets doneEmitted; a stale is_final/FlushDone landing after it
    // would otherwise resolve the next turn's flush wait before synthesis ran.
    const { session, ws } = await openSession();
    let done = 0;
    session.on("done", () => {
      done += 1;
    });

    session.sendText("old turn");
    session.cancel();
    expect(done).toBe(1);
    await tick();

    session.sendText("new turn");
    ws._msg({ type: "Audio", audio: pcmBase64([9]), is_final: true }); // old socket
    ws._msg({ type: "FlushDone" }); // old socket
    expect(done).toBe(1);

    const next = FakeWebSocket.instances.at(-1);
    next?._msg({ type: "FlushDone" });
    expect(done).toBe(2);
  });

  test("a turn after cancel synthesizes only its own text", async () => {
    const { session, ws } = await openSession();
    session.sendText("first half");
    session.cancel();
    // The replacement is still connecting: the next turn's frames queue and
    // flush to it on open — the old server-side buffer died with its socket.
    session.sendText("fresh turn");
    session.flush();
    await tick();

    const next = FakeWebSocket.instances.at(-1);
    expect(next).not.toBe(ws);
    expect(next?._frames()).toEqual([{ type: "Generate", text: "fresh turn" }, { type: "Flush" }]);
    // "first half" has no sentence end, so it was still buffered host-side and
    // never reached the old socket — Generate only goes out paired with a Flush.
    expect(ws._frames()).toEqual([{ type: "Terminate" }]);
  });

  test("cancel while the replacement is still connecting drops the queued frames", async () => {
    const { session } = await openSession();
    session.sendText("one");
    session.cancel();
    session.sendText("two"); // queued for the connecting socket
    session.cancel(); // cancelled before the frames ever left the process
    session.sendText("three");
    session.flush();
    await tick();

    expect(FakeWebSocket.instances).toHaveLength(2);
    const next = FakeWebSocket.instances.at(-1);
    expect(next?._frames()).toEqual([{ type: "Generate", text: "three" }, { type: "Flush" }]);
  });

  test("a reconnect that black-holes fails the session instead of muting it", async () => {
    // A dropped SYN or stalled proxy emits neither "open" nor "error". Without
    // a deadline the adapter queues frames forever: every later turn's flushes
    // count as sent while nothing reaches the wire, and each reply burns the
    // full pipeline flush timeout in silence.
    vi.useFakeTimers();
    try {
      const { session } = await openSession();
      const errors: TtsError[] = [];
      session.on("error", (err) => errors.push(err));

      session.sendText("half a reply");
      FakeWebSocket.neverOpen = true;
      session.cancel(); // reconnect begins; the replacement never opens

      await vi.advanceTimersByTimeAsync(TTS_RECONNECT_TIMEOUT_MS + 1);

      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe("tts_stream_error");
      expect(errors[0]?.message).toContain("reconnect after cancel failed");
    } finally {
      vi.useRealTimers();
    }
  });

  test("the INITIAL connect is bounded too, and drops the socket when it black-holes", async () => {
    // The reconnect above always carried a deadline; the initial open did not,
    // and the constant's own doc claimed it was "bounded by session.start()'s
    // timeout" — true of the SESSION and false of the SOCKET. `ws-handler`'s
    // pTimeout says in its own comment that it does not cancel the underlying
    // start(), so a black-holed connect outlived the session waiting on it.
    vi.useFakeTimers();
    try {
      FakeWebSocket.neverOpen = true;
      const controller = new AbortController();
      const openPromise = openAssemblyAITts({}).open({
        sampleRate: 16_000,
        apiKey: "test-key",
        signal: controller.signal,
      });
      // Handler first: the timer settles the promise inside advanceTimers, and
      // a rejection with none attached is an unhandled rejection.
      const rejected = expect(openPromise).rejects.toMatchObject({ code: "tts_connect_failed" });

      await vi.advanceTimersByTimeAsync(WS_OPEN_TIMEOUT_MS + 1);

      await rejected;
      expect(FakeWebSocket.instances.at(-1)?.readyState).toBe(FakeWebSocket.CLOSED);
    } finally {
      vi.useRealTimers();
    }
  });

  test("an abort during the initial connect abandons the socket", async () => {
    // `closeOnAbort` is registered only AFTER the connect resolves, so before
    // this the session's own hang-up could not reach a socket still connecting.
    FakeWebSocket.neverOpen = true;
    const controller = new AbortController();
    const openPromise = openAssemblyAITts({}).open({
      sampleRate: 16_000,
      apiKey: "test-key",
      signal: controller.signal,
    });

    controller.abort();

    await expect(openPromise).rejects.toMatchObject({ code: "tts_connect_failed" });
    expect(FakeWebSocket.instances.at(-1)?.readyState).toBe(FakeWebSocket.CLOSED);
  });

  test("close() after cancel closes the replacement socket", async () => {
    const { session } = await openSession();
    session.sendText("hi");
    session.cancel();
    await tick();
    const next = FakeWebSocket.instances.at(-1);
    await session.close();
    expect(next?.readyState).toBe(FakeWebSocket.CLOSED);
    expect(next?._frames()).toContainEqual({ type: "Terminate" });
  });
});
