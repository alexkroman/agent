// Copyright 2026 the AAI authors. MIT license.
/**
 * Unit test for the AssemblyAI experimental STT opener: the turn segmenter
 * (behind the level gate), the request encoding, and the session driven
 * through its `fetch` seam against a scripted endpoint.
 */

import { ASSEMBLYAI_EXPERIMENTAL_DEFAULT_PROMPT } from "@alexkroman1/aai/host-internal";
import { describe, expect, test, vi } from "vitest";
import { tick } from "../../_timing-test-utils.ts";
import {
  buildTranscribeBody,
  createBlocker,
  createTurnSegmenter,
  type ExperimentalSttFetch,
  encodeWav,
  levelVoiced,
  MAX_CONSECUTIVE_FINAL_FAILURES,
  openAssemblyAIExperimentalStt,
  PREROLL_MS,
  parseTranscript,
} from "./assemblyai-experimental.ts";

const RATE = 16_000;

/** `ms` of a loud square wave — voiced at any sane threshold. */
function speech(ms: number): Int16Array {
  const pcm = new Int16Array((RATE * ms) / 1000);
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.floor(i / 20) % 2 === 0 ? 8000 : -8000;
  return pcm;
}

/** `ms` of digital silence. */
function silence(ms: number): Int16Array {
  return new Int16Array((RATE * ms) / 1000);
}

function segmenter(overrides: { partialIntervalMs?: number; minTurnSilenceMs?: number } = {}) {
  const ends: { samples: number; startMs: number; turnId: number }[] = [];
  const partials: { samples: number; turnId: number }[] = [];
  const blockSamples = RATE / 50;
  const inner = createTurnSegmenter({
    sampleRate: RATE,
    blockSamples,
    minTurnSilenceMs: overrides.minTurnSilenceMs ?? 500,
    partialIntervalMs: overrides.partialIntervalMs ?? 0,
    onTurnEnd: (pcm, startMs, turnId) => ends.push({ samples: pcm.length, startMs, turnId }),
    onPartialDue: (pcm, _startMs, turnId) => partials.push({ samples: pcm.length, turnId }),
  });
  // The level gate, as the opener wires it.
  const push = createBlocker(blockSamples, (b) => inner.pushBlock(b, levelVoiced(b, -45)));
  return { seg: { ...inner, push }, ends, partials };
}

describe("createTurnSegmenter", () => {
  test("silence alone opens no turn", () => {
    const { seg, ends } = segmenter();
    seg.push(silence(3000));
    expect(seg.inTurn()).toBe(false);
    expect(ends).toEqual([]);
  });

  test("ends a turn after the silence window, keeping pre-roll and a short tail", () => {
    const { seg, ends } = segmenter();
    seg.push(silence(1000));
    seg.push(speech(1000));
    expect(seg.inTurn()).toBe(true);
    seg.push(silence(499));
    expect(ends).toEqual([]);
    seg.push(silence(21));
    expect(ends).toHaveLength(1);
    const [turn] = ends;
    // Opened PREROLL_MS before the first voiced block's run reached 60 ms.
    expect(turn?.startMs).toBe(1000 - PREROLL_MS);
    // Pre-roll + speech + a pre-roll's worth of tail: the rest is trimmed.
    expect(turn?.samples).toBe((RATE * (PREROLL_MS + 1000 + PREROLL_MS)) / 1000);
    expect(seg.inTurn()).toBe(false);
  });

  test("a pause shorter than the window keeps the turn open", () => {
    const { seg, ends } = segmenter();
    seg.push(speech(500));
    seg.push(silence(300));
    seg.push(speech(500));
    seg.push(silence(600));
    expect(ends).toHaveLength(1);
    expect(ends[0]?.turnId).toBe(1);
  });

  test("a click shorter than the start run opens no turn", () => {
    const { seg } = segmenter();
    seg.push(speech(40));
    seg.push(silence(200));
    expect(seg.inTurn()).toBe(false);
  });

  test("forceEnd ends the open turn now, and is a no-op otherwise", () => {
    const { seg, ends } = segmenter();
    seg.forceEnd();
    seg.push(speech(400));
    seg.forceEnd();
    seg.forceEnd();
    expect(ends).toHaveLength(1);
  });

  test("setMinTurnSilenceMs moves the window mid-stream", () => {
    const { seg, ends } = segmenter({ minTurnSilenceMs: 2000 });
    seg.push(speech(400));
    seg.setMinTurnSilenceMs(200);
    seg.push(silence(220));
    expect(ends).toHaveLength(1);
  });

  test("asks for a partial every interval while the turn is open", () => {
    const { seg, partials } = segmenter({ partialIntervalMs: 500 });
    seg.push(speech(1600));
    expect(partials.map((p) => p.turnId)).toEqual([1, 1, 1]);
    expect(partials[0]?.samples).toBeLessThan(partials[1]?.samples ?? 0);
  });

  test("frames of any size cut into the same blocks", () => {
    const whole = segmenter();
    const sliced = segmenter();
    const audio = [silence(400), speech(700), silence(600)];
    for (const a of audio) whole.seg.push(a);
    for (const a of audio)
      for (let i = 0; i < a.length; i += 137) sliced.seg.push(a.slice(i, i + 137));
    expect(sliced.ends).toEqual(whole.ends);
  });
});

describe("request encoding", () => {
  test("encodeWav writes a PCM16 mono RIFF header", () => {
    const wav = encodeWav(new Int16Array([1, -1]), RATE);
    const view = new DataView(wav.buffer);
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe("RIFF");
    expect(view.getUint32(24, true)).toBe(RATE);
    expect(view.getUint32(40, true)).toBe(4);
    expect(view.getInt16(46, true)).toBe(-1);
  });

  test("buildTranscribeBody carries the config and the audio parts", () => {
    const body = new TextDecoder().decode(
      buildTranscribeBody(new Uint8Array([65, 66]), "say it", "BOUND"),
    );
    expect(body).toContain('name="config"\r\n\r\n{"prompt":"say it"}\r\n--BOUND\r\n');
    expect(body).toContain(
      'name="audio"; filename="turn.wav"\r\nContent-Type: audio/wav\r\n\r\nAB',
    );
    expect(body.endsWith("\r\n--BOUND--\r\n")).toBe(true);
  });

  test("parseTranscript probes field by field", () => {
    expect(parseTranscript(null)).toEqual({ text: "", words: [] });
    expect(
      parseTranscript({ text: "hi", words: [{ text: "hi", start: 10, end: 90 }, { start: "x" }] }),
    ).toEqual({ text: "hi", words: [{ start: 10, end: 90 }] });
  });
});

type Call = { headers: Record<string, string>; body: string };

/** A scripted endpoint: answers `texts` in order, recording each request. */
function scriptedFetch(answer: (n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch: ExperimentalSttFetch = async (_url, init) => {
    calls.push({
      headers: init?.headers as Record<string, string>,
      body: new TextDecoder().decode(init?.body as Uint8Array),
    });
    return answer(calls.length);
  };
  return { fetch, calls };
}

/** A response the test releases by hand. */
function held() {
  let release: (r: Response) => void = () => undefined;
  const response = new Promise<Response>((r) => {
    release = r;
  });
  return { response, release: (r: Response) => release(r) };
}

const ok = (text: string, words = [{ start: 300, end: 900 }]) =>
  new Response(JSON.stringify({ text, words }), { status: 200 });

async function open(fetch: ExperimentalSttFetch, sttPrompt?: string) {
  const session = await openAssemblyAIExperimentalStt({ partialIntervalMs: 0 }, fetch).open({
    sampleRate: RATE,
    apiKey: "sandbox-key",
    sttPrompt,
    signal: new AbortController().signal,
  });
  const events = { partial: vi.fn(), final: vi.fn(), error: vi.fn() };
  session.on("partial", events.partial);
  session.on("final", events.final);
  session.on("error", events.error);
  return { session, events };
}

describe("openAssemblyAIExperimentalStt", () => {
  test("refuses an empty key", async () => {
    const opener = openAssemblyAIExperimentalStt({}, scriptedFetch(() => ok("")).fetch);
    await expect(
      opener.open({ sampleRate: RATE, apiKey: "", signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: "stt_auth_failed" });
  });

  test("posts a finished turn and emits its final with word-timed meta", async () => {
    const { fetch, calls } = scriptedFetch(() => ok("Hello there."));
    const { session, events } = await open(fetch);
    session.sendAudio(speech(800));
    // The default window is 1000 ms: a 800 ms pause is mid-sentence, not a turn end.
    session.sendAudio(silence(800));
    await tick();
    expect(calls).toHaveLength(0);
    session.sendAudio(silence(400));
    await tick();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers).toMatchObject({
      Authorization: "sandbox-key",
      "X-AAI-Model": "nemotron-3-5-transcribe",
    });
    expect(calls[0]?.body).toContain(
      JSON.stringify({ prompt: ASSEMBLYAI_EXPERIMENTAL_DEFAULT_PROMPT }),
    );
    expect(events.final).toHaveBeenCalledWith(
      "Hello there.",
      expect.objectContaining({ spokenMs: 600 }),
    );
  });

  test("the agent's sttPrompt replaces the default prompt", async () => {
    const { fetch, calls } = scriptedFetch(() => ok("x"));
    const { session } = await open(fetch, "names: Kroman");
    session.sendAudio(speech(300));
    session.forceEndOfTurn?.();
    await tick();
    expect(calls[0]?.body).toContain(JSON.stringify({ prompt: "names: Kroman" }));
  });

  test("emits finals in turn order whichever request answers first", async () => {
    const first = held();
    const { fetch } = scriptedFetch((n) => (n === 1 ? first.response : ok("second")));
    const { session, events } = await open(fetch);
    session.sendAudio(speech(300));
    session.forceEndOfTurn?.();
    session.sendAudio(speech(300));
    session.forceEndOfTurn?.();
    await tick();
    expect(events.final).not.toHaveBeenCalled();
    first.release(ok("first"));
    await tick();
    expect(events.final.mock.calls.map((c) => c[0])).toEqual(["first", "second"]);
  });

  test("drops a blank final", async () => {
    const { fetch } = scriptedFetch(() => ok("  ", []));
    const { session, events } = await open(fetch);
    session.sendAudio(speech(300));
    session.forceEndOfTurn?.();
    await tick();
    expect(events.final).not.toHaveBeenCalled();
    expect(events.error).not.toHaveBeenCalled();
  });

  test("a refused key ends the session at once, as an auth error", async () => {
    const { fetch, calls } = scriptedFetch(() => new Response("nope", { status: 401 }));
    const { session, events } = await open(fetch);
    session.sendAudio(speech(300));
    session.forceEndOfTurn?.();
    await tick();
    expect(events.error.mock.calls[0]?.[0]).toMatchObject({ code: "stt_auth_failed" });
    // Not retried: a refused key will be refused again.
    expect(calls).toHaveLength(1);
  });

  test("a transient server error on a final is retried once, and the turn is answered", async () => {
    const answers = [new Response("bad gateway", { status: 502 }), ok("Hello there.")];
    const { fetch, calls } = scriptedFetch((n) => answers[n - 1] ?? ok(""));
    const { session, events } = await open(fetch);
    session.sendAudio(speech(300));
    session.forceEndOfTurn?.();
    await tick();
    expect(calls).toHaveLength(2);
    expect(events.final).toHaveBeenCalledWith("Hello there.", expect.anything());
    expect(events.error).not.toHaveBeenCalled();
  });

  test("a final that timed out is retried too", async () => {
    // A timeout is a DOMException, whose `code` is a number: it must not be
    // read as an SttError's refusal.
    let n = 0;
    const fetch: ExperimentalSttFetch = async () => {
      n++;
      if (n === 1) throw new DOMException("The operation timed out.", "TimeoutError");
      return ok("After the timeout.");
    };
    const { session, events } = await open(fetch);
    session.sendAudio(speech(300));
    session.forceEndOfTurn?.();
    await tick();
    expect(events.final).toHaveBeenCalledWith("After the timeout.", expect.anything());
    expect(events.error).not.toHaveBeenCalled();
  });

  test("a turn whose final fails twice is skipped, and the session goes on", async () => {
    const answers = [
      new Response("down", { status: 503 }),
      new Response("down", { status: 503 }),
      ok("Second turn."),
    ];
    const { fetch } = scriptedFetch((n) => answers[n - 1] ?? ok(""));
    const { session, events } = await open(fetch);
    session.sendAudio(speech(300));
    session.forceEndOfTurn?.();
    await tick();
    expect(events.error).not.toHaveBeenCalled();
    session.sendAudio(speech(300));
    session.forceEndOfTurn?.();
    await tick();
    expect(events.final).toHaveBeenCalledWith("Second turn.", expect.anything());
    expect(events.error).not.toHaveBeenCalled();
  });

  test(`${MAX_CONSECUTIVE_FINAL_FAILURES} failed finals in a row end the session`, async () => {
    const { fetch } = scriptedFetch(() => new Response("down", { status: 503 }));
    const { session, events } = await open(fetch);
    for (let turn = 1; turn <= MAX_CONSECUTIVE_FINAL_FAILURES; turn++) {
      expect(events.error, `before turn ${turn}`).not.toHaveBeenCalled();
      session.sendAudio(speech(300));
      session.forceEndOfTurn?.();
      await tick();
    }
    expect(events.error.mock.calls[0]?.[0]).toMatchObject({ code: "stt_stream_error" });
  });

  test("a partial left over from the last turn does not hold back the next turn's", async () => {
    // Turn 1's partial never answers; turn 2 must still get partials (they
    // are what drive barge-in), and the stale request is aborted.
    const stale = held();
    let staleSignal: AbortSignal | undefined;
    let n = 0;
    const fetch: ExperimentalSttFetch = async (_url, init) => {
      n++;
      if (n === 1) {
        staleSignal = init?.signal ?? undefined;
        return stale.response;
      }
      return n === 2 ? ok("Turn one.") : ok("Second");
    };
    const session = await openAssemblyAIExperimentalStt({ partialIntervalMs: 200 }, fetch).open({
      sampleRate: RATE,
      apiKey: "k",
      signal: new AbortController().signal,
    });
    const partial = vi.fn();
    session.on("partial", partial);
    session.sendAudio(speech(220));
    session.forceEndOfTurn?.();
    await tick();
    session.sendAudio(speech(220));
    await tick();
    expect(partial).toHaveBeenCalledWith("Second", expect.anything());
    expect(staleSignal?.aborted).toBe(true);
  });

  test("emits a partial while the turn is open, and drops one that lands after it", async () => {
    const second = held();
    const answers = [ok("I would"), second.response];
    const { fetch } = scriptedFetch((n) => answers[n - 1] ?? ok("done"));
    const session = await openAssemblyAIExperimentalStt({ partialIntervalMs: 200 }, fetch).open({
      sampleRate: RATE,
      apiKey: "k",
      signal: new AbortController().signal,
    });
    const partial = vi.fn();
    session.on("partial", partial);
    session.sendAudio(speech(220));
    await tick();
    expect(partial).toHaveBeenCalledWith("I would", expect.anything());
    session.sendAudio(speech(200));
    session.forceEndOfTurn?.();
    second.release(ok("stale"));
    await tick();
    expect(partial).toHaveBeenCalledTimes(1);
  });

  test("close aborts a request in flight and emits nothing after", async () => {
    let seen: AbortSignal | undefined;
    const fetch: ExperimentalSttFetch = (_url, init) => {
      seen = init?.signal ?? undefined;
      return new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
      );
    };
    const { session, events } = await open(fetch);
    session.sendAudio(speech(300));
    session.forceEndOfTurn?.();
    await session.close();
    await tick();
    expect(seen?.aborted).toBe(true);
    expect(events.error).not.toHaveBeenCalled();
    expect(events.final).not.toHaveBeenCalled();
  });
});
