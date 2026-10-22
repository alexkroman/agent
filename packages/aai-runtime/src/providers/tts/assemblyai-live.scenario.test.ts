// Copyright 2026 the AAI authors. MIT license.
/**
 * The AssemblyAI streaming-TTS clients against the LIVE service.
 *
 * Every other TTS spec drives a fake socket, so none of them can tell a URL,
 * param or frame the service refuses from one it accepts — the retired `voice`
 * param kept passing them all while the documented host closed every such
 * session with 3006. These run the real opener (`openAssemblyAITts`) and the
 * real step synthesizer (`speakOverWebSocket`) end to end on
 * `ASSEMBLYAI_API_KEY`, checking what https://www.assemblyai.com/docs/tts
 * promises: audio arrives, the turn ends, word timings come back, the EU host
 * and every library voice work, `Cancel` leaves the socket usable, an unknown
 * voice fails the session, and a text over the per-frame cap still speaks.
 *
 * SCENARIO tier: real network. Without a key the suite is skipped OUT LOUD.
 */

import {
  ASSEMBLYAI_TTS_EU_HOST,
  ASSEMBLYAI_TTS_MAX_GENERATE_CHARS,
} from "@alexkroman1/aai/host-internal";
import { ASSEMBLYAI_TTS_VOICES, type AssemblyAITtsOptions } from "@alexkroman1/aai/tts";
import { describe, expect, test } from "vitest";
import { speakOverWebSocket } from "../../step-speak.ts";
import type { TtsError, TtsSession, TtsWordTiming } from "../openers.ts";
import { openAssemblyAITts } from "./assemblyai.ts";

const KEY = process.env.ASSEMBLYAI_API_KEY ?? "";
const RATE = 24_000;
const TURN_TIMEOUT_MS = 30_000;

// Aliased, as `_pg-test-utils.ts` does: the skip is ANNOUNCED below, which is
// what biome's `noSkippedTests` exists to make sure of.
const skipSuite = describe.skip;

function describeWithKey(name: string, body: () => void): void {
  if (KEY !== "") {
    describe(name, body);
    return;
  }
  console.warn("\n[skipped: no ASSEMBLYAI_API_KEY] live streaming-TTS suite not run.\n");
  skipSuite(name, body);
}

/** One turn's output: what arrived before `done`, or the error that ended it. */
type Turn = { samples: number; words: TtsWordTiming[]; error?: TtsError };

/**
 * How long to keep listening for word timings after `done`: the service sends a
 * flush's `WordBoundaries` AFTER its `FlushDone` (docs, message frames).
 */
const WORDS_GRACE_MS = 1500;

/** Speak `text` as one turn on `session` and collect what came back. */
function speakTurn(session: TtsSession, text: string): Promise<Turn> {
  const turn: Turn = { samples: 0, words: [] };
  return new Promise<Turn>((resolve) => {
    const timer = setTimeout(() => resolve(turn), TURN_TIMEOUT_MS);
    const finish = (): void => {
      clearTimeout(timer);
      setTimeout(() => {
        for (const off of offs) off();
        resolve(turn);
      }, WORDS_GRACE_MS);
    };
    const offs = [
      session.on("audio", (pcm) => {
        turn.samples += pcm.length;
      }),
      session.on("words", (words) => {
        turn.words.push(...words);
      }),
      session.on("done", finish),
      session.on("error", (err) => {
        turn.error = err;
        finish();
      }),
    ];
    session.sendText(text);
    session.flush();
  });
}

async function open(options: AssemblyAITtsOptions = {}): Promise<TtsSession> {
  return openAssemblyAITts(options).open({
    sampleRate: RATE,
    apiKey: KEY,
    signal: AbortSignal.timeout(TURN_TIMEOUT_MS * 2),
  });
}

describeWithKey("AssemblyAI streaming TTS, live", () => {
  test("the default voice speaks a reply, ends the turn, and reports word timings", async () => {
    const session = await open();
    try {
      const turn = await speakTurn(session, "Hello there. This is a live check of the voice.");
      expect(turn.error).toBeUndefined();
      // Well over half a second of 24 kHz audio for two sentences.
      expect(turn.samples).toBeGreaterThan(RATE / 2);
      expect(turn.words.map((w) => w.text.toLowerCase())).toContain("hello");
    } finally {
      await session.close();
    }
  });

  test("one socket carries several turns", async () => {
    const session = await open();
    try {
      for (const text of ["First turn.", "Second turn, same socket."]) {
        const turn = await speakTurn(session, text);
        expect(turn.error, text).toBeUndefined();
        expect(turn.samples, text).toBeGreaterThan(0);
      }
    } finally {
      await session.close();
    }
  });

  test("the EU host speaks", async () => {
    const session = await open({ host: ASSEMBLYAI_TTS_EU_HOST });
    try {
      const turn = await speakTurn(session, "Hello from the EU.");
      expect(turn.error).toBeUndefined();
      expect(turn.samples).toBeGreaterThan(0);
    } finally {
      await session.close();
    }
  });

  test("a library voice speaks a non-English language", async () => {
    const session = await open({ voice: "aai-vera", language: "es" });
    try {
      const turn = await speakTurn(session, "Hola, ¿cómo estás hoy?");
      expect(turn.error).toBeUndefined();
      expect(turn.samples).toBeGreaterThan(0);
    } finally {
      await session.close();
    }
  });

  test.each(ASSEMBLYAI_TTS_VOICES)("catalog voice %s is one the service accepts", async (voice) => {
    const session = await open({ voice });
    try {
      const turn = await speakTurn(session, "Hi.");
      expect(turn.error).toBeUndefined();
      expect(turn.samples).toBeGreaterThan(0);
    } finally {
      await session.close();
    }
  });

  test("a cancelled turn leaves the socket able to speak the next one", async () => {
    const session = await open();
    try {
      session.sendText("This sentence is going to be cut off before it can finish speaking. ");
      session.cancel();
      const turn = await speakTurn(session, "After the cancel.");
      expect(turn.error).toBeUndefined();
      expect(turn.samples).toBeGreaterThan(0);
    } finally {
      await session.close();
    }
  });

  test("a bare voice name is not a voice_id, and fails the session rather than muting it", async () => {
    const session = await open({ voice: "jane" });
    try {
      const turn = await speakTurn(session, "Hello.");
      expect(turn.error?.message).toMatch(/3012/);
      expect(turn.samples).toBe(0);
    } finally {
      await session.close();
    }
  });

  test("stepSpeak speaks a text longer than one Generate frame may carry", async () => {
    const text = "This is a long sentence for the speech step. ".repeat(50);
    expect(text.length).toBeGreaterThan(ASSEMBLYAI_TTS_MAX_GENERATE_CHARS);
    const pcm = await speakOverWebSocket({
      text,
      apiKey: KEY,
      voice: "aai-jane",
      sampleRate: RATE,
      signal: AbortSignal.timeout(90_000),
    });
    // PCM16: two bytes a sample. 2250 characters is well over a minute of speech.
    expect(pcm.length / 2 / RATE).toBeGreaterThan(60);
  }, 120_000);
});
