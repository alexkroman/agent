// Copyright 2026 the AAI authors. MIT license.

import { RIME_DEFAULT_LANGUAGE, RIME_DEFAULT_MODEL } from "@alexkroman1/aai/host-internal";
import { RIME_DEFAULT_VOICE, type RimeTtsOptions } from "@alexkroman1/aai/tts";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { flush } from "../../_test-utils.ts";
import { WS_OPEN_TIMEOUT_MS } from "../_socket.ts";
// The shared TTS fake, not a fourth copy of it — see its module comment for
// the divergence three hand-rolled copies had already produced.
import { FakeWebSocket, pcmBase64 } from "./_fake-ws-test-utils.ts";
import { openRime, type RimeSession } from "./rime.ts";

// Async factory importing an import-free module: the adapter's own "ws"
// import must not be reachable from the factory (it would re-enter the mock).
vi.mock("ws", async () => {
  const { FakeWebSocket } = await import("./_fake-ws-test-utils.ts");
  return { default: FakeWebSocket, WebSocket: FakeWebSocket };
});

beforeEach(() => {
  FakeWebSocket.reset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

async function openSession(
  opts: RimeTtsOptions = {},
  sampleRate = 16_000,
): Promise<{
  session: RimeSession;
  ws: FakeWebSocket;
  controller: AbortController;
}> {
  const opener = openRime(opts);
  const controller = new AbortController();

  const openPromise = opener.open({
    sampleRate,
    apiKey: "test-key",
    signal: controller.signal,
  }) as Promise<RimeSession>;

  // Let the queued microtask that fires "open" run.
  await flush();

  const session = await openPromise;
  const ws = FakeWebSocket.instances.at(-1);
  if (!ws) throw new Error("no WebSocket was constructed");
  return { session, ws, controller };
}

describe("rime TTS adapter", () => {
  test("openRime returns an opener with name 'rime'", () => {
    const opener = openRime({ voice: "cove" });
    expect(opener.name).toBe("rime");
  });

  test("dials ws2 with the descriptor's speaker, model, format, rate and language", async () => {
    // Nothing anywhere asserted what this adapter actually dials, so a dropped
    // `Bearer ` prefix, a renamed query param, a wrong `samplingRate`
    // (chipmunk audio at exactly the right byte count) or a two-letter `lang`
    // where Rime takes ISO 639-3 all passed the suite.
    const { ws } = await openSession({ voice: "marsh", model: "arcana", language: "spa" }, 24_000);
    const url = new URL(ws.url);
    expect(url.host).toBe("users-ws.rime.ai");
    expect(url.pathname).toBe("/ws2");
    const params = url.searchParams;
    expect(params.get("speaker")).toBe("marsh");
    expect(params.get("modelId")).toBe("arcana");
    expect(params.get("audioFormat")).toBe("pcm");
    expect(params.get("samplingRate")).toBe("24000");
    expect(params.get("lang")).toBe("spa");
    expect(ws.options?.headers?.Authorization).toBe("Bearer test-key");
  });

  test("fills the host-side defaults when the descriptor names none", async () => {
    const { ws } = await openSession();
    const params = new URL(ws.url).searchParams;
    expect(params.get("speaker")).toBe(RIME_DEFAULT_VOICE);
    expect(params.get("modelId")).toBe(RIME_DEFAULT_MODEL);
    // ISO 639-3, not the 639-1 code most APIs take: Rime rejects `"en"`.
    expect(params.get("lang")).toBe(RIME_DEFAULT_LANGUAGE);
    expect(RIME_DEFAULT_LANGUAGE).toHaveLength(3);
  });

  test("opens with permessage-deflate disabled", async () => {
    // `ws` defaults this to true on CLIENTS, and a provider that accepts the
    // offer costs a zlib context per socket (+321 KiB RSS, ~4.5x CPU, measured)
    // to compress PCM16, which does not compress. See PROVIDER_WS_OPTIONS.
    const { ws } = await openSession();
    expect(ws.options?.perMessageDeflate).toBe(false);
  });

  test("open() throws tts_auth_failed when API key is missing", async () => {
    const opener = openRime({ voice: "cove" });
    const controller = new AbortController();

    const openPromise = opener.open({
      sampleRate: 16_000,
      apiKey: "",
      signal: controller.signal,
    });

    await expect(openPromise).rejects.toMatchObject({ code: "tts_auth_failed" });
  });

  test("an initial connect that black-holes fails the open instead of hanging forever", async () => {
    // A dropped SYN or a stalled proxy emits neither "open" nor "error". With
    // no deadline `waitForOpen` never settled, so `providers.open()` never
    // resolved: the ws-handler rejected the SESSION at its own timeout without
    // cancelling this connect, leaving the socket held by a pending listener
    // with no owner.
    FakeWebSocket.neverOpen = true;
    const controller = new AbortController();
    const openPromise = openRime({ voice: "cove" }).open({
      sampleRate: 16_000,
      apiKey: "test-key",
      signal: controller.signal,
    });
    // Assert on the rejection BEFORE advancing: the timer settles the promise
    // inside `advanceTimersByTimeAsync`, and a rejection with no handler yet
    // attached is an unhandled rejection the runner reports.
    const rejected = expect(openPromise).rejects.toMatchObject({ code: "tts_connect_failed" });

    await vi.advanceTimersByTimeAsync(WS_OPEN_TIMEOUT_MS + 1);

    await rejected;
    expect(FakeWebSocket.instances.at(-1)?.readyState).toBe(FakeWebSocket.CLOSED);
  });

  test("an abort during the connect abandons the socket rather than waiting it out", async () => {
    // `closeOnAbort` is registered only AFTER the connect resolves, so before
    // this the session's own hang-up could not reach a socket still connecting.
    FakeWebSocket.neverOpen = true;
    const controller = new AbortController();
    const openPromise = openRime({ voice: "cove" }).open({
      sampleRate: 16_000,
      apiKey: "test-key",
      signal: controller.signal,
    });

    controller.abort();

    await expect(openPromise).rejects.toMatchObject({ code: "tts_connect_failed" });
    expect(FakeWebSocket.instances.at(-1)?.readyState).toBe(FakeWebSocket.CLOSED);
  });

  test("a throwing audio listener cannot escape the socket's message handler", async () => {
    // Emitting straight off the emitter let a downstream throw escape into
    // Node's EventEmitter as an uncaughtException, taking down a multi-tenant
    // host rather than one session. `shell.emit` owns the containment.
    const { session, ws } = await openSession();
    const listener = vi.fn(() => {
      throw new Error("listener blew up");
    });
    session.on("audio", listener);
    expect(() =>
      ws._msg({ type: "chunk", data: pcmBase64([1, 2]), contextId: null }),
    ).not.toThrow();
    // The event really fired — otherwise the assertion above is vacuous.
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("a throwing error listener cannot escape the socket's message handler", async () => {
    const { session, ws } = await openSession();
    const listener = vi.fn(() => {
      throw new Error("listener blew up");
    });
    session.on("error", listener);

    expect(() => ws._msg({ type: "error", message: "upstream said no" })).not.toThrow();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("incoming chunk message emits audio as Int16Array", async () => {
    const { session, ws } = await openSession();

    const audioEvents: Int16Array[] = [];
    session.on("audio", (pcm) => audioEvents.push(pcm));

    ws._msg({ type: "chunk", data: pcmBase64([100, 200, 300, 400]), contextId: null });

    expect(audioEvents).toHaveLength(1);
    const [pcm] = audioEvents;
    expect(pcm).toBeInstanceOf(Int16Array);
    // Byte-for-byte, not just the length: an endianness flip or a wrong
    // `byteOffset` sends noise at exactly the right size.
    expect(Array.from(pcm ?? [])).toEqual([100, 200, 300, 400]);
  });

  test("sendText forwards the text as a JSON {text} frame", async () => {
    const { session, ws } = await openSession();

    session.sendText("Hello, world!");

    expect(ws.sent).toContain(JSON.stringify({ text: "Hello, world!" }));
  });

  test("flush() sends a trailing '.' and emits done after quiescence post-audio", async () => {
    const { session, ws } = await openSession();

    const onDone = vi.fn();
    session.on("done", onDone);

    session.sendText("Hi there");
    session.flush();

    // Trailing punctuation forces Rime to synthesize the buffer without
    // closing the WS (which `eos` would do).
    expect(ws.sent).toContain(JSON.stringify({ text: "." }));

    // First-audio timer is 5s — short window must not fire `done` yet.
    vi.advanceTimersByTime(500);
    expect(onDone).not.toHaveBeenCalled();

    // First chunk arrives, switching to the short quiescence window.
    ws._msg({ type: "chunk", data: pcmBase64([100, 200, 300, 400]), contextId: null });

    vi.advanceTimersByTime(499);
    expect(onDone).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  test("flush() falls back to first-audio timeout when no chunk arrives", async () => {
    const { session } = await openSession();

    const onDone = vi.fn();
    session.on("done", onDone);

    session.sendText("Hi there");
    session.flush();

    // No chunk arrives — must wait the full FIRST_AUDIO_TIMEOUT_MS (5s).
    vi.advanceTimersByTime(4999);
    expect(onDone).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  test("cancel() sends clear operation and emits done synchronously", async () => {
    const { session, ws } = await openSession();

    const onDone = vi.fn();
    session.on("done", onDone);

    session.sendText("Hello");
    // Barge-in cannot be deferred — `done` must fire synchronously.
    session.cancel();

    expect(ws.sent).toContain(JSON.stringify({ operation: "clear" }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  test("cancel() clears pending timers so no stale done leaks into the next turn", async () => {
    const { session } = await openSession();

    const onDone = vi.fn();
    session.on("done", onDone);

    // Turn 1 flushes (arming the first-audio timer), then is barged in.
    session.sendText("turn one");
    session.flush();
    session.cancel();
    expect(onDone).toHaveBeenCalledTimes(1); // cancel's own synchronous done

    // Turn 2 begins. Turn 1's timer must have been cleared by cancel() —
    // if it survived, it would fire here and end turn 2's flush-wait early
    // (TtsEvents contract: done never fires for a cancelled turn).
    session.sendText("turn two");
    vi.advanceTimersByTime(10_000);
    expect(onDone).toHaveBeenCalledTimes(1);

    // Turn 2's own flush still completes normally.
    session.flush();
    vi.advanceTimersByTime(5000);
    expect(onDone).toHaveBeenCalledTimes(2);
  });

  test("close() closes the WebSocket and is idempotent", async () => {
    const { session, ws } = await openSession();

    expect(ws.readyState).toBe(FakeWebSocket.OPEN);

    await session.close();
    expect(ws.readyState).toBe(FakeWebSocket.CLOSED);

    await expect(session.close()).resolves.toBeUndefined();
  });

  test("close() drops the session listeners but leaves a no-op error guard", async () => {
    const { session, ws } = await openSession();
    expect(ws.listenerCount()).toBeGreaterThan(1);
    await session.close();
    // The session's message/close/error handlers are gone; only a single
    // no-op `error` guard remains so a late error during the close handshake
    // can't crash the process.
    expect(ws.listenerCount()).toBe(1);
    expect(() => ws._fire("error", new Error("late reset"))).not.toThrow();
  });
});
