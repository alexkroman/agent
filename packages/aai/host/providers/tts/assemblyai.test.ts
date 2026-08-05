// Copyright 2026 the AAI authors. MIT license.

import { beforeEach, describe, expect, test, vi } from "vitest";
import type { AssemblyAITtsLanguage } from "../../../sdk/providers/tts/assemblyai.ts";
import type { TtsError } from "../../../sdk/providers.ts";
import { tick } from "../../_test-utils.ts";
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

describe("AssemblyAI TTS adapter", () => {
  test("opener is named 'assemblyai'", () => {
    expect(openAssemblyAITts({}).name).toBe("assemblyai");
  });

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
    let done = 0;
    session.on("done", () => {
      done += 1;
    });

    session.sendText("hi");
    session.flush();
    ws._msg({ type: "FlushDone" });
    ws._msg({ type: "FlushDone" });

    expect(done).toBe(1);
  });

  test("an Audio frame flagged is_final also ends the turn", async () => {
    // Older servers flag the last frame instead of sending FlushDone.
    const { session, ws } = await openSession();
    let done = 0;
    session.on("done", () => {
      done += 1;
    });
    session.sendText("hi");
    ws._msg({ type: "Audio", audio: pcmBase64([7]), is_final: true });
    expect(done).toBe(1);
  });

  test("a new turn can complete after the previous one finished", async () => {
    const { session, ws } = await openSession();
    let done = 0;
    session.on("done", () => {
      done += 1;
    });

    session.sendText("one");
    ws._msg({ type: "FlushDone" });
    session.sendText("two");
    ws._msg({ type: "FlushDone" });

    expect(done).toBe(2);
  });

  test("no done fires before a turn starts", async () => {
    const { session, ws } = await openSession();
    let done = 0;
    session.on("done", () => {
      done += 1;
    });
    ws._msg({ type: "FlushDone" });
    expect(done).toBe(0);
  });

  describe("mid-stream segment flushing", () => {
    // The service synthesizes NOTHING until it receives a Flush: measured
    // against production, a turn's Generate frames produce zero audio and the
    // first Audio frame lands ~33ms after Flush. The pipeline only flushes at
    // the end-of-turn drain (flushTtsAndWait, once per reply — after every LLM
    // step AND every tool call), so without a segment flush time-to-first-audio
    // is the whole turn. Cartesia has no equivalent: `continue: true` starts
    // synthesis on arrival.
    test("flushes at a sentence boundary so synthesis starts mid-stream", async () => {
      const { session, ws } = await openSession();
      session.sendText("Sure, I can help with that. ");
      expect(ws._frames()).toEqual([
        { type: "Generate", text: "Sure, I can help with that. " },
        { type: "Flush" },
      ]);
    });

    test("does not flush mid-sentence text", async () => {
      const { session, ws } = await openSession();
      session.sendText("Sure, I can help ");
      expect(ws._frames()).toEqual([]);
    });

    test("does not flush a single-token fragment", async () => {
      // "Dr. " is an abbreviation, not a sentence end. Flushing it makes a
      // word-sized utterance: measured 25% longer total audio for the same
      // text, because each flushed segment gets its own prosody and padding.
      const { session, ws } = await openSession();
      session.sendText("Dr. ");
      expect(ws._frames()).toEqual([]);
    });

    test("a decimal point is not a sentence end", async () => {
      const { session, ws } = await openSession();
      session.sendText("The total is 3.5 million ");
      expect(ws._frames()).toEqual([]);
    });

    test("keeps an abbreviation with the sentence that follows it", async () => {
      const { session, ws } = await openSession();
      session.sendText("Dr. ");
      session.sendText("Smith is here. ");
      expect(ws._frames()).toEqual([
        { type: "Generate", text: "Dr. Smith is here. " },
        { type: "Flush" },
      ]);
    });

    test("splits a sentence end buried mid-delta rather than missing it", async () => {
      // The pipeline coalescer's 32-char cap can put a sentence end in the
      // middle of a chunk. Matching only the chunk's tail would miss it and
      // silently restore the whole-turn lag, so the split happens here.
      const { session, ws } = await openSession();
      session.sendText("All done. And now the next ");
      expect(ws._frames()).toEqual([{ type: "Generate", text: "All done. " }, { type: "Flush" }]);

      session.flush();
      expect(ws._frames()).toEqual([
        { type: "Generate", text: "All done. " },
        { type: "Flush" },
        { type: "Generate", text: "And now the next " },
        { type: "Flush" },
      ]);
    });

    test("flushes through the last complete sentence when several arrive at once", async () => {
      // One larger segment sounds better than several small ones.
      const { session, ws } = await openSession();
      session.sendText("One thing. Two things. Still going ");
      expect(ws._frames()).toEqual([
        { type: "Generate", text: "One thing. Two things. " },
        { type: "Flush" },
      ]);
    });

    test("flushes the hold phrase, which must be audible during tool execution", async () => {
      // DEFAULT_HOLD_PHRASE is "One moment." — two words. Its entire purpose is
      // to break silence while a tool runs, so it cannot wait for the turn's
      // end-of-turn flush.
      const { session, ws } = await openSession();
      session.sendText("One moment.");
      expect(ws._frames()).toContainEqual({ type: "Flush" });
    });

    test("a segment flush does not end the turn", async () => {
      // The turn ends on the end-of-turn flush's FlushDone, not a segment's:
      // flushTtsAndWait resolves on `done`, so a premature one advances the
      // orchestrator while audio is still streaming.
      const { session, ws } = await openSession();
      let done = 0;
      session.on("done", () => {
        done += 1;
      });

      session.sendText("First sentence here. ");
      ws._msg({ type: "FlushDone" }); // the segment's
      expect(done).toBe(0);

      session.sendText("And the rest ");
      session.flush(); // end of turn
      ws._msg({ type: "FlushDone" });
      expect(done).toBe(1);
    });

    test("accumulates across deltas and flushes once the sentence completes", async () => {
      const { session, ws } = await openSession();
      session.sendText("Sure, ");
      session.sendText("I can help ");
      session.sendText("with that. ");
      expect(ws._frames()).toEqual([
        { type: "Generate", text: "Sure, I can help with that. " },
        { type: "Flush" },
      ]);
    });

    test("never sends an empty Flush at end of turn", async () => {
      // Observed against production: an empty Flush can go unacknowledged, and
      // `done` then never fires — flushTtsAndWait would burn its full timeout on
      // every turn, which is worse than the lag this flushing fixes.
      const { session, ws } = await openSession();
      let done = 0;
      session.on("done", () => {
        done += 1;
      });

      session.sendText("The whole reply fits in one sentence. ");
      ws._msg({ type: "FlushDone" });
      const before = ws._frames().length;

      session.flush(); // nothing buffered
      expect(ws._frames()).toHaveLength(before);
      // All synthesis was already acknowledged, so the turn ends here.
      expect(done).toBe(1);
    });

    test("an end-of-turn flush with nothing buffered waits for outstanding audio", async () => {
      const { session, ws } = await openSession();
      let done = 0;
      session.on("done", () => {
        done += 1;
      });

      session.sendText("One sentence. ");
      session.flush(); // nothing buffered, but the segment is unacknowledged
      expect(done).toBe(0);

      ws._msg({ type: "FlushDone" });
      expect(done).toBe(1);
    });

    test("a segment's is_final does not end the turn either", async () => {
      // Older servers flag the last Audio frame instead of sending FlushDone;
      // per segment that signal means the same thing and must be gated the same.
      const { session, ws } = await openSession();
      let done = 0;
      session.on("done", () => {
        done += 1;
      });
      session.sendText("First sentence here. ");
      ws._msg({ type: "Audio", audio: pcmBase64([1]), is_final: true });
      expect(done).toBe(0);
    });

    test("an is_final AND its FlushDone count as one acknowledgement", async () => {
      // A server may signal a synthesis's completion both ways. Counting the
      // pair twice reads the surplus FlushDone as unsolicited and ends the
      // turn mid-reply — done fires while later sentences are still
      // synthesizing, audio_done overtakes their audio, and the buffered text
      // below ("And the rest") is dropped: the voice cuts off before the
      // reply finishes. Exhaustive ack-pairing cases: assemblyai-turn.test.ts.
      const { session, ws } = await openSession();
      let done = 0;
      session.on("done", () => {
        done += 1;
      });

      session.sendText("First sentence here. ");
      session.sendText("And the rest");
      ws._msg({ type: "Audio", audio: pcmBase64([1]), is_final: true }); // segment's final frame
      ws._msg({ type: "FlushDone" }); // same flush, acked again
      expect(done).toBe(0);

      session.sendText(" of the reply. ");
      session.flush(); // end of turn — "And the rest of the reply. " must go out
      expect(ws._frames()).toContainEqual({
        type: "Generate",
        text: "And the rest of the reply. ",
      });
      expect(done).toBe(0);

      ws._msg({ type: "Audio", audio: pcmBase64([2]), is_final: true });
      expect(done).toBe(1); // exactly once, on the LAST flush's acknowledgement
      ws._msg({ type: "FlushDone" });
      expect(done).toBe(1);
    });

    test("cancel clears pending segment state so the next turn ends normally", async () => {
      const { session } = await openSession();
      let done = 0;
      session.on("done", () => {
        done += 1;
      });

      session.sendText("Interrupted sentence. ");
      session.cancel(); // emits done for the cancelled turn, drops the socket
      expect(done).toBe(1);

      // Let the replacement socket finish connecting so queued frames go out.
      await tick();
      const next = FakeWebSocket.instances.at(-1);
      session.sendText("New turn ");
      session.flush();
      next?._msg({ type: "FlushDone" });
      expect(done).toBe(2);
    });
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
    let done = 0;
    session.on("done", () => {
      done += 1;
    });

    session.sendText("a long reply");
    session.cancel();

    // Synchronous, not microtask-deferred: the orchestrator's state machine
    // advances on `done`.
    expect(done).toBe(1);
  });

  test("an unexpected server close releases a turn in flight", async () => {
    const { session, ws } = await openSession();
    let done = 0;
    session.on("done", () => {
      done += 1;
    });
    session.sendText("hi");
    ws._fire("close");
    expect(done).toBe(1);
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
    let done = 0;
    session.on("done", () => {
      done += 1;
    });

    session.sendText("mid turn");
    ws._fire("close", 1000);

    expect(done).toBe(1); // the in-flight turn is released...
    expect(errors).toHaveLength(1); // ...and the session fails loudly
    expect(errors[0]?.code).toBe("tts_stream_error");
    expect(errors[0]?.message).toContain("1000");
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
    await Promise.resolve();
    expect(ws.readyState).toBe(FakeWebSocket.CLOSED);
  });
});
