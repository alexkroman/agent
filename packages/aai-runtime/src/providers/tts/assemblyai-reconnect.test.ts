// Copyright 2026 the AAI authors. MIT license.
// AssemblyAI TTS cancel() specs — split from assemblyai.test.ts for file
// length. A mid-turn cancel sends a `Cancel` frame and KEEPS the socket; the
// server's `Cancelled` is the boundary past which the abandoned turn's frames
// stop arriving. Dropping the connection is the fallback for a socket that
// cannot carry the frame. See the adapter's module doc for the measurements.

import type { TtsError } from "@alexkroman1/aai/host-internal";
import {
  TTS_CANCEL_ACK_TIMEOUT_MS,
  TTS_RECONNECT_TIMEOUT_MS,
} from "@alexkroman1/aai/host-internal";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { tick } from "../../_test-utils.ts";
import { WS_OPEN_TIMEOUT_MS } from "../_socket.ts";
import { openSession } from "./_assemblyai-session-test-utils.ts";
import { FakeWebSocket, pcmBase64 } from "./_fake-ws-test-utils.ts";
import { openAssemblyAITts } from "./assemblyai.ts";

// Async factory importing an import-free module: the adapter's own "ws"
// import must not be reachable from the factory (it would re-enter the mock).
vi.mock("ws", async () => {
  const { FakeWebSocket } = await import("./_fake-ws-test-utils.ts");
  return { default: FakeWebSocket, WebSocket: FakeWebSocket };
});

beforeEach(() => {
  FakeWebSocket.reset();
});

describe("AssemblyAI TTS cancel()", () => {
  // `Cancel` discards the server's buffered text and aborts synthesis in
  // progress, so the socket survives a barge-in — see the module doc for the
  // production measurements behind both claims.

  test("cancel mid-turn sends Cancel and keeps the socket", async () => {
    const { session, ws } = await openSession();
    session.sendText("half a reply");
    session.cancel();

    expect(ws._frames()).toContainEqual({ type: "Cancel" });
    expect(ws.readyState).toBe(FakeWebSocket.OPEN);
    await tick();
    // The whole point: no reconnect at the moment the caller is talking.
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(session._ws).toBe(ws);
  });

  test("cancel with no turn in flight sends nothing (and is idempotent)", async () => {
    const { session, ws } = await openSession();
    session.cancel();
    expect(ws._frames()).toEqual([]);

    session.sendText("hi");
    session.cancel();
    session.cancel(); // second cancel of the same turn: no second Cancel frame
    expect(ws._frames().filter((f) => f.type === "Cancel")).toHaveLength(1);
  });

  test("the cancelled turn's trailing frames are dropped until Cancelled", async () => {
    // The socket used to be dropped, which made these unobservable for free.
    // It survives now, so ~0.3s of in-flight audio really does still arrive.
    const { session, ws } = await openSession();
    const events: string[] = [];
    session.on("audio", () => events.push("audio"));
    session.on("done", () => events.push("done"));

    session.sendText("cancelled reply");
    session.cancel();
    expect(events).toEqual(["done"]); // synchronous barge-in done

    ws._msg({ type: "Audio", audio: pcmBase64([1, 2]) });
    ws._msg({ type: "FlushDone" });
    ws._msg({ type: "WordBoundaries", words: [{ text: "cancelled", audio_start_ms: 0 }] });
    expect(events).toEqual(["done"]);
  });

  test("frames resume once Cancelled marks the boundary", async () => {
    // The other half of the window: a barrier that never lifts is a session
    // that never plays audio again.
    const { session, ws } = await openSession();
    const events: string[] = [];
    session.on("audio", () => events.push("audio"));

    session.sendText("cancelled reply");
    session.cancel();
    ws._msg({ type: "Audio", audio: pcmBase64([1]) }); // still the old turn
    expect(events).toEqual([]);

    ws._msg({ type: "Cancelled" });
    session.sendText("new turn ");
    ws._msg({ type: "Audio", audio: pcmBase64([2]) });
    expect(events).toEqual(["audio"]);
  });

  test("a second barge-in before the first Cancelled keeps the window shut", async () => {
    // Counted rather than a flag: the first Cancelled must not reopen the
    // window while the second cancel's frames are still on the wire.
    const { session, ws } = await openSession();
    const events: string[] = [];
    session.on("audio", () => events.push("audio"));

    session.sendText("first ");
    session.cancel();
    session.sendText("second ");
    session.cancel();

    ws._msg({ type: "Cancelled" }); // only the FIRST of two
    ws._msg({ type: "Audio", audio: pcmBase64([1]) });
    expect(events).toEqual([]);

    ws._msg({ type: "Cancelled" });
    ws._msg({ type: "Audio", audio: pcmBase64([2]) });
    expect(events).toEqual(["audio"]);
  });

  test("an Error inside the cancel window still surfaces", async () => {
    // Deliberate exception: an Error frame describes the SOCKET, not the
    // abandoned turn, and swallowing it would mute the session silently.
    const { session, ws } = await openSession();
    const errors: TtsError[] = [];
    session.on("error", (err) => errors.push(err));

    session.sendText("cancelled reply");
    session.cancel();
    ws._msg({ type: "Error", error_code: 1008, error: "Unauthorized" });

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("Unauthorized");
  });

  test("a late old-turn ack cannot end the next turn early", async () => {
    // sendText resets doneEmitted; a stale is_final/FlushDone landing after it
    // would otherwise retire one of the NEW turn's outstanding flushes.
    const { session, ws } = await openSession();
    const onDone = vi.fn();
    session.on("done", onDone);

    session.sendText("old turn");
    session.cancel();
    expect(onDone).toHaveBeenCalledTimes(1);

    session.sendText("new turn ");
    ws._msg({ type: "Audio", audio: pcmBase64([9]), is_final: true }); // cancelled turn
    ws._msg({ type: "FlushDone" }); // cancelled turn
    expect(onDone).toHaveBeenCalledTimes(1);

    ws._msg({ type: "Cancelled" });
    session.flush();
    ws._msg({ type: "FlushDone" });
    expect(onDone).toHaveBeenCalledTimes(2);
  });

  test("a turn after cancel synthesizes only its own text", async () => {
    const { session, ws } = await openSession();
    session.sendText("first half");
    session.cancel();
    ws._msg({ type: "Cancelled" });

    session.sendText("fresh turn");
    session.flush();

    // "first half" has no sentence end, so it was still buffered host-side and
    // never reached the socket — Generate only goes out paired with a Flush.
    // The Cancel is what clears the server's own buffer; measured, see the doc.
    expect(ws._frames()).toEqual([
      { type: "Cancel" },
      { type: "Generate", text: "fresh turn" },
      { type: "Flush" },
    ]);
  });
});

describe("AssemblyAI TTS cancel() reconnect fallback", () => {
  // Dropping the socket is no longer the cancel path, but it remains the
  // recovery for a socket that cannot carry a Cancel or will not answer one.

  test("a Cancel that cannot be sent falls back to the reconnect", async () => {
    const { session, ws } = await openSession();
    session.sendText("half a reply");
    ws.readyState = FakeWebSocket.CLOSED; // send() refuses

    session.cancel();

    await tick();
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(session._ws).not.toBe(ws);
  });

  test("a Cancelled that never arrives falls back to the reconnect", async () => {
    // Otherwise the suppression window never lifts and the session is mute
    // for the rest of the call — the failure the deadline exists to prevent.
    vi.useFakeTimers();
    try {
      const { session, ws } = await openSession();
      const events: string[] = [];
      session.on("audio", () => events.push("audio"));
      session.sendText("half a reply");
      session.cancel();

      await vi.advanceTimersByTimeAsync(TTS_CANCEL_ACK_TIMEOUT_MS + 1);
      expect(FakeWebSocket.instances).toHaveLength(2);
      expect(ws.readyState).toBe(FakeWebSocket.CLOSED);

      // `tick()` is a setTimeout(0) and would hang here — advance the clock
      // instead, which is also what lets the replacement socket open.
      await vi.advanceTimersByTimeAsync(0);
      // And the replacement is audible, i.e. the barrier really reopened.
      const next = FakeWebSocket.instances.at(-1);
      session.sendText("new turn ");
      next?._msg({ type: "Audio", audio: pcmBase64([1]) });
      expect(events).toEqual(["audio"]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("cancel while the replacement is still connecting drops the queued frames", async () => {
    const { session, ws } = await openSession();
    session.sendText("one");
    ws.readyState = FakeWebSocket.CLOSED; // force the reconnect path
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
      const { session, ws } = await openSession();
      const errors: TtsError[] = [];
      session.on("error", (err) => errors.push(err));

      session.sendText("half a reply");
      FakeWebSocket.neverOpen = true;
      ws.readyState = FakeWebSocket.CLOSED; // force the reconnect path
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

  test("close() after a fallback reconnect closes the replacement socket", async () => {
    const { session, ws } = await openSession();
    session.sendText("hi");
    ws.readyState = FakeWebSocket.CLOSED; // force the reconnect path
    session.cancel();
    await tick();
    const next = FakeWebSocket.instances.at(-1);
    await session.close();
    expect(next?.readyState).toBe(FakeWebSocket.CLOSED);
    expect(next?._frames()).toContainEqual({ type: "Terminate" });
  });
});
