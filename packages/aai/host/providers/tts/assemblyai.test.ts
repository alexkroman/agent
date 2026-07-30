// Copyright 2026 the AAI authors. MIT license.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type {
  AssemblyAITtsLanguage,
  AssemblyAITtsOptions,
} from "../../../sdk/providers/tts/assemblyai.ts";
import type { TtsError } from "../../../sdk/providers.ts";
import { type AssemblyAITtsSession, openAssemblyAITts } from "./assemblyai.ts";

type WsEvent = "open" | "message" | "error" | "close";
type WsListener = (...args: unknown[]) => void;

const { FakeWebSocket } = vi.hoisted(() => {
  class FakeWebSocket {
    static OPEN = 1;
    static CLOSED = 3;
    static instances: FakeWebSocket[] = [];

    readyState = FakeWebSocket.OPEN;
    sent: string[] = [];
    readonly url: string;
    readonly options: { headers?: Record<string, string> } | undefined;
    private readonly listeners = new Map<string, WsListener[]>();

    constructor(url: string, opts?: { headers?: Record<string, string> }) {
      this.url = url;
      this.options = opts;
      FakeWebSocket.instances.push(this);
      // Real `ws` fires "open" asynchronously; match that timing.
      queueMicrotask(() => this._fire("open"));
    }

    on(event: string, fn: WsListener) {
      const arr = this.listeners.get(event) ?? [];
      arr.push(fn);
      this.listeners.set(event, arr);
    }

    once(event: string, fn: WsListener) {
      const wrapper = (...args: unknown[]) => {
        this.removeListener(event, wrapper);
        fn(...args);
      };
      this.on(event, wrapper);
    }

    removeListener(event: string, fn: WsListener) {
      const arr = this.listeners.get(event) ?? [];
      this.listeners.set(
        event,
        arr.filter((l) => l !== fn),
      );
    }

    off(event: string, fn: WsListener) {
      this.removeListener(event, fn);
    }

    removeAllListeners() {
      this.listeners.clear();
    }

    send(data: string) {
      this.sent.push(data);
    }

    close() {
      this.readyState = FakeWebSocket.CLOSED;
      this._fire("close");
    }

    _fire(event: WsEvent, ...args: unknown[]) {
      for (const fn of this.listeners.get(event) ?? []) fn(...args);
    }

    _msg(payload: unknown) {
      this._fire("message", JSON.stringify(payload));
    }

    _frames(): Record<string, unknown>[] {
      return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
    }
  }

  return { FakeWebSocket };
});

vi.mock("ws", () => ({
  default: FakeWebSocket,
  WebSocket: FakeWebSocket,
}));

beforeEach(() => {
  FakeWebSocket.instances.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Base64 of one PCM16 LE sample per value. */
function pcmBase64(samples: number[]): string {
  const buf = Buffer.alloc(samples.length * 2);
  for (const [i, v] of samples.entries()) buf.writeInt16LE(v, i * 2);
  return buf.toString("base64");
}

async function openSession(
  opts: AssemblyAITtsOptions = {},
  apiKey = "test-key",
): Promise<{
  session: AssemblyAITtsSession;
  ws: InstanceType<typeof FakeWebSocket>;
  controller: AbortController;
}> {
  const opener = openAssemblyAITts(opts);
  const controller = new AbortController();
  const openPromise = opener.open({
    sampleRate: 16_000,
    apiKey,
    signal: controller.signal,
  }) as Promise<AssemblyAITtsSession>;
  await Promise.resolve(); // let the queued "open" microtask run
  const session = await openPromise;
  const ws = FakeWebSocket.instances.at(-1);
  if (!ws) throw new Error("no WebSocket was constructed");
  return { session, ws, controller };
}

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
    expect(params.get("voice")).toBe("vera");
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
      await new Promise((r) => setTimeout(r, 0));
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

describe("AssemblyAI TTS cancel() reconnect", () => {
  // The protocol has no discard/cancel frame, so a mid-turn cancel must drop
  // the connection (and with it the server-side text buffer + in-flight
  // audio) and reconnect — see the module doc.

  /** Let the replacement socket's queued "open" fire and the queue flush. */
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  test("cancel mid-turn drops the socket and reconnects", async () => {
    const { session, ws } = await openSession();
    session.sendText("half a reply");
    session.cancel();
    expect(ws.readyState).toBe(FakeWebSocket.CLOSED);
    await settle();
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
    await settle();
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

    await settle();
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
    await settle();

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
    await settle();

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
    await settle();

    expect(FakeWebSocket.instances).toHaveLength(2);
    const next = FakeWebSocket.instances.at(-1);
    expect(next?._frames()).toEqual([{ type: "Generate", text: "three" }, { type: "Flush" }]);
  });

  test("close() after cancel closes the replacement socket", async () => {
    const { session } = await openSession();
    session.sendText("hi");
    session.cancel();
    await settle();
    const next = FakeWebSocket.instances.at(-1);
    await session.close();
    expect(next?.readyState).toBe(FakeWebSocket.CLOSED);
    expect(next?._frames()).toContainEqual({ type: "Terminate" });
  });
});
