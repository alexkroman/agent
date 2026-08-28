// Copyright 2026 the AAI authors. MIT license.

import type { TtsError } from "@alexkroman1/aai/host-internal";
import type { AssemblyAITtsLanguage } from "@alexkroman1/aai/tts";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { flush } from "../../_test-utils.ts";
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

describe("AssemblyAI TTS adapter", () => {
  test("opener is named 'assemblyai'", () => {
    expect(openAssemblyAITts({}).name).toBe("assemblyai");
  });

  test.each([
    ["audio", false, (ws: FakeWebSocket) => ws._msg({ type: "Audio", audio: pcmBase64([1, 2]) })],
    ["done", true, (ws: FakeWebSocket) => ws._msg({ type: "FlushDone" })],
  ] as const)(
    "a throwing %s listener cannot escape the socket's message handler",
    async (event, endTurn, fire) => {
      // Emitting straight off the emitter let a downstream throw escape into
      // Node's EventEmitter as an uncaughtException, taking down a multi-tenant
      // host rather than one session. `shell.emit` owns the containment.
      const { session, ws } = await openSession();
      session.sendText("a sentence. ");
      if (endTurn) session.flush();
      const listener = vi.fn(() => {
        throw new Error("listener blew up");
      });
      session.on(event, listener);

      expect(() => fire(ws)).not.toThrow();
      // The event really fired — otherwise the assertion above is vacuous.
      expect(listener).toHaveBeenCalledTimes(1);
    },
  );

  test("connects to the production streaming-TTS host with voice and sample rate", async () => {
    const { ws } = await openSession({ voice: "michael" });
    const url = new URL(ws.url);
    expect(url.host).toBe("streaming-tts.assemblyai.com");
    expect(url.pathname).toBe("/v1/ws/");
    expect(url.searchParams.get("voice")).toBe("michael");
    expect(url.searchParams.get("sample_rate")).toBe("16000");
  });

  test("defaults the voice and omits language unless set", async () => {
    const { ws } = await openSession();
    const params = new URL(ws.url).searchParams;
    expect(params.get("voice")).toBe("jane");
    // Every voice speaks one language; a mismatched pair is worse than no hint.
    expect(params.has("language")).toBe(false);
  });

  test("sends the language as the API's full name, not the ISO 639-1 code", async () => {
    // The service rejects codes in-band: `Bad connection parameters: language:
    // language 'es' not in supported set ['english', ...]` — which arrives
    // AFTER the socket opens, so an unmapped code is a silently mute session.
    const { ws } = await openSession({ voice: "lola", language: "es" });
    expect(new URL(ws.url).searchParams.get("language")).toBe("spanish");
  });

  test.each<[AssemblyAITtsLanguage, string]>([
    ["en", "english"],
    ["fr", "french"],
    ["de", "german"],
    ["it", "italian"],
    ["pt", "portuguese"],
    ["es", "spanish"],
  ])("maps %s to %s", async (code, wire) => {
    const { ws } = await openSession({ language: code });
    expect(new URL(ws.url).searchParams.get("language")).toBe(wire);
  });

  test("open() throws tts_connect_failed for an unsupported language", async () => {
    // Fail at connect rather than let the service refuse in-band: the
    // descriptor reaches the host as unvalidated `Record<string, unknown>`
    // options, so this is the only place a bad value can be caught.
    const opener = openAssemblyAITts({ language: "zh" as "es" });
    await expect(
      opener.open({ sampleRate: 16_000, apiKey: "k", signal: new AbortController().signal }),
    ).rejects.toMatchObject({
      code: "tts_connect_failed",
      message: expect.stringContaining("zh"),
    });
  });

  test("authenticates with the raw API key, not a Bearer token", async () => {
    // A Bearer token upgrades fine and is then refused in-band as an Error
    // frame, so this is the difference between working and a runtime failure.
    const { ws } = await openSession({}, "sk-abc123");
    expect(ws.options?.headers?.Authorization).toBe("sk-abc123");
  });

  test("opens with permessage-deflate disabled", async () => {
    // `ws` defaults this to true on CLIENTS, and a provider that accepts the
    // offer costs a zlib context per socket (+321 KiB RSS, ~4.5x CPU, measured)
    // to compress PCM16, which does not compress. See PROVIDER_WS_OPTIONS.
    const { ws } = await openSession({}, "sk-abc123");
    expect(ws.options?.perMessageDeflate).toBe(false);
  });

  test("open() throws tts_auth_failed when the API key is missing", async () => {
    const opener = openAssemblyAITts({});
    await expect(
      opener.open({ sampleRate: 16_000, apiKey: "", signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: "tts_auth_failed" });
  });

  test("sendText buffers and flush sends the turn's text as Generate + Flush", async () => {
    // Generate is only ever sent paired with a Flush: the service synthesizes
    // nothing until it is flushed, so holding the text costs nothing and keeps
    // the segment split owned here. See the module doc.
    const { session, ws } = await openSession();
    session.sendText("Hello ");
    session.sendText("there");
    expect(ws._frames()).toEqual([]);

    session.flush();
    expect(ws._frames()).toEqual([{ type: "Generate", text: "Hello there" }, { type: "Flush" }]);
  });

  test("empty text is not sent", async () => {
    const { session, ws } = await openSession();
    session.sendText("");
    expect(ws.sent).toEqual([]);
  });

  test("Audio frames decode base64 PCM16 into audio events", async () => {
    const { session, ws } = await openSession();
    const chunks: Int16Array[] = [];
    session.on("audio", (pcm) => chunks.push(pcm));

    session.sendText("hi");
    ws._msg({ type: "Audio", audio: pcmBase64([1, -2, 3]) });

    expect(chunks).toHaveLength(1);
    expect(Array.from(chunks[0] ?? [])).toEqual([1, -2, 3]);
  });

  test("FlushDone ends the turn exactly once", async () => {
    const { session, ws } = await openSession();
    const onDone = vi.fn();
    session.on("done", onDone);

    session.sendText("hi");
    session.flush();
    ws._msg({ type: "FlushDone" });
    ws._msg({ type: "FlushDone" });

    expect(onDone).toHaveBeenCalledTimes(1);
  });

  test("an Audio frame flagged is_final also ends the turn", async () => {
    // Older servers flag the last frame instead of sending FlushDone.
    const { session, ws } = await openSession();
    const onDone = vi.fn();
    session.on("done", onDone);
    session.sendText("hi");
    ws._msg({ type: "Audio", audio: pcmBase64([7]), is_final: true });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  test("a new turn can complete after the previous one finished", async () => {
    const { session, ws } = await openSession();
    const onDone = vi.fn();
    session.on("done", onDone);

    session.sendText("one");
    ws._msg({ type: "FlushDone" });
    session.sendText("two");
    ws._msg({ type: "FlushDone" });

    expect(onDone).toHaveBeenCalledTimes(2);
  });

  test("no done fires before a turn starts", async () => {
    const { session, ws } = await openSession();
    const onDone = vi.fn();
    session.on("done", onDone);
    ws._msg({ type: "FlushDone" });
    expect(onDone).not.toHaveBeenCalled();
  });

  test("Begin and Warning frames are not treated as audio or errors", async () => {
    const { session, ws } = await openSession();
    const seen: string[] = [];
    session.on("audio", () => seen.push("audio"));
    session.on("error", () => seen.push("error"));

    ws._msg({ type: "Begin", configuration: { sample_rate: 16_000 } });
    ws._msg({ type: "Warning", warning: "voice fallback" });

    expect(seen).toEqual([]);
  });

  test("Error frames surface as tts_stream_error with the server detail", async () => {
    const { session, ws } = await openSession();
    const errors: TtsError[] = [];
    session.on("error", (err) => errors.push(err));

    ws._msg({ type: "Error", error_code: "invalid_voice", error: "no such voice" });

    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("tts_stream_error");
    expect(errors[0]?.message).toContain("invalid_voice");
    expect(errors[0]?.message).toContain("no such voice");
  });

  test("cancel ends the turn synchronously for barge-in", async () => {
    const { session } = await openSession();
    const onDone = vi.fn();
    session.on("done", onDone);

    session.sendText("a long reply");
    session.cancel();

    // Synchronous, not microtask-deferred: the orchestrator's state machine
    // advances on `done`.
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  test("an unexpected server close releases a turn in flight", async () => {
    const { session, ws } = await openSession();
    const onDone = vi.fn();
    session.on("done", onDone);
    session.sendText("hi");
    ws._fire("close");
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  test("a server-initiated clean close (1000) fails the session instead of muting it", async () => {
    // dropSocket() detaches listeners before every close we initiate, so any
    // close reaching the handler is the server's. This is one long-lived
    // socket per session: after a 1000 (idle policy, deploy) every later send
    // is dropped by the readyState guard and each turn would "complete" with
    // zero audio — permanently, silently mute unless the close is surfaced.
    const { session, ws } = await openSession();
    const errors: TtsError[] = [];
    session.on("error", (err) => errors.push(err));
    const onDone = vi.fn();
    session.on("done", onDone);

    session.sendText("mid turn");
    ws._fire("close", 1000);

    expect(onDone).toHaveBeenCalledTimes(1); // the in-flight turn is released...
    expect(errors).toHaveLength(1); // ...and the session fails loudly
    expect(errors[0]?.code).toBe("tts_stream_error");
    expect(errors[0]?.message).toContain("1000");
  });

  describe("word boundaries", () => {
    /** Collect the `words` event for one open session. */
    function collectWords(session: { on: (e: "words", fn: (w: unknown) => void) => void }): {
      seen: unknown[];
    } {
      const seen: unknown[] = [];
      session.on("words", (w) => seen.push(w));
      return { seen };
    }

    test("a WordBoundaries frame is re-emitted as `words`, rebased onto the turn", async () => {
      const { session, ws } = await openSession();
      const { seen } = collectWords(session);
      session.sendText("Your balance. ");
      ws._msg({
        type: "WordBoundaries",
        words: [
          { text: "Your", audio_start_ms: 4000, audio_end_ms: 4200 },
          { text: "balance", audio_start_ms: 4200, audio_end_ms: 4640 },
        ],
      });
      expect(seen).toEqual([
        [
          { text: "Your", startMs: 0, endMs: 200 },
          { text: "balance", startMs: 200, endMs: 640 },
        ],
      ]);
    });

    test("an unreadable frame emits nothing and does not error the session", async () => {
      const { session, ws } = await openSession();
      const { seen } = collectWords(session);
      const errors: TtsError[] = [];
      session.on("error", (err) => errors.push(err));
      session.sendText("Your balance. ");
      ws._msg({ type: "WordBoundaries", words: "not a list" });
      expect(seen).toEqual([]);
      expect(errors).toEqual([]);
    });

    test("a WordBoundaries frame is NOT an acknowledgement", async () => {
      // The contract guard: routing it into the turn tracker would retire an
      // outstanding flush, so `done` — and the client's audio_done — would
      // overtake the reply's remaining audio and cut it off mid-sentence.
      const { session, ws } = await openSession();
      const onDone = vi.fn();
      session.on("done", onDone);
      session.sendText("One thing. ");
      session.sendText("Two things. ");
      session.flush();
      ws._msg({ type: "FlushDone" });
      ws._msg({ type: "WordBoundaries", words: [{ text: "One", audio_start_ms: 0 }] });
      expect(onDone).not.toHaveBeenCalled();
      ws._msg({ type: "FlushDone" });
      expect(onDone).toHaveBeenCalledTimes(1);
    });

    test("a frame for a cancelled turn cannot reach the next one", async () => {
      const { session, ws } = await openSession();
      const { seen } = collectWords(session);
      session.sendText("Your balance. ");
      session.cancel();
      // The cancelled socket's listeners are detached before it closes, so its
      // late frames are unobservable — the same guarantee its late audio has.
      ws._msg({ type: "WordBoundaries", words: [{ text: "Your", audio_start_ms: 0 }] });
      expect(seen).toEqual([]);
    });

    test("a frame trailing the final FlushDone still reaches the turn it belongs to", async () => {
      // The service emits a segment's WordBoundaries AFTER that segment's own
      // FlushDone — measured against the sandbox host, ~20 ms after, on every
      // reply's LAST segment. Guarding on "is a turn in flight" therefore threw
      // away the tail of every reply's timeline (14.19 s of 17.76 s of audio
      // covered), and the final segment silently degraded to the proportional
      // estimate `heardChars` falls back to.
      const { session, ws } = await openSession();
      const { seen } = collectWords(session);
      session.sendText("Your balance. ");
      session.flush();
      ws._msg({ type: "FlushDone" }); // turn over — its last frame is still in flight
      ws._msg({
        type: "WordBoundaries",
        words: [{ text: "Your", audio_start_ms: 0, audio_end_ms: 300 }],
      });
      expect(seen).toEqual([[{ text: "Your", startMs: 0, endMs: 300 }]]);
    });

    test("a frame trailing a CANCELLED turn is still dropped, past the barrier", async () => {
      // The cancel barrier only filters up to `Cancelled`; the turn's own
      // trailing frame can land after it. `turn.inFlight()` used to cover this
      // case for the wrong reason, so widening the window above had to close
      // this one explicitly — the client dropped that reply's audio, and a
      // timing for it would walk the heard cursor through speech nobody heard.
      const { session, ws } = await openSession();
      const { seen } = collectWords(session);
      session.sendText("Your balance. ");
      session.cancel();
      ws._msg({ type: "Cancelled" }); // barrier reopens here
      ws._msg({ type: "WordBoundaries", words: [{ text: "Your", audio_start_ms: 0 }] });
      expect(seen).toEqual([]);
    });

    test("the next turn's first text reopens the window and re-anchors at zero", async () => {
      const { session, ws } = await openSession();
      const { seen } = collectWords(session);
      session.sendText("First reply. ");
      session.flush();
      ws._msg({ type: "FlushDone" });
      session.sendText("Second reply. ");
      ws._msg({
        type: "WordBoundaries",
        words: [{ text: "Second", audio_start_ms: 9000, audio_end_ms: 9400 }],
      });
      expect(seen).toEqual([[{ text: "Second", startMs: 0, endMs: 400 }]]);
    });
  });

  test("close sends Terminate and closes the socket", async () => {
    const { session, ws } = await openSession();
    await session.close();
    expect(ws._frames()).toContainEqual({ type: "Terminate" });
    expect(ws.readyState).toBe(FakeWebSocket.CLOSED);
  });

  test("nothing is sent after close", async () => {
    const { session, ws } = await openSession();
    await session.close();
    const after = ws.sent.length;
    session.sendText("ignored");
    session.flush();
    expect(ws.sent).toHaveLength(after);
  });

  test("aborting the signal closes the session", async () => {
    const { ws, controller } = await openSession();
    controller.abort();
    await flush();
    expect(ws.readyState).toBe(FakeWebSocket.CLOSED);
  });
});
