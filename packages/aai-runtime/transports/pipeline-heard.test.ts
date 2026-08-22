// Copyright 2026 the AAI authors. MIT license.
// Unit specs for the heard cursor — the one answer history truncation and the
// resume anchor both read. Wired-up behaviour (barge-in → history) lives in
// pipeline-transport-barge-in.test.ts.

import type { TtsWordTiming } from "@alexkroman1/aai/host-internal";
import { describe, expect, test } from "vitest";
import { createTestClock, type TestClock } from "../_pipeline-test-fakes.ts";
import { createHeardTracker, type HeardTracker } from "./pipeline-heard.ts";

const RATE = 24_000;
/** One PCM16 chunk of `ms` at {@link RATE}. */
const chunk = (ms: number): Int16Array => new Int16Array((RATE * ms) / 1000);

function setup(lagMs = 0): { heard: HeardTracker; clock: TestClock } {
  const clock = createTestClock();
  return { heard: createHeardTracker({ sampleRate: RATE, lagMs, now: clock.now }), clock };
}

const REPLY = "Hello there friend";
/** Word timings covering {@link REPLY}, in ms into the turn's audio. */
const WORDS: TtsWordTiming[] = [
  { text: "Hello", startMs: 0, endMs: 400 },
  { text: "there", startMs: 400, endMs: 800 },
  { text: "friend", startMs: 800, endMs: 1000 },
];

describe("createHeardTracker — the heard position", () => {
  test("a reply with no forwarded audio was heard by nobody", () => {
    const { heard } = setup();
    heard.startReply();
    heard.onText(REPLY, true);
    expect(heard.heard()).toEqual({ chars: 0, recordableChars: 0, text: "" });
  });

  test("audio forwarded but not yet played out is not heard either", () => {
    const { heard } = setup();
    heard.startReply();
    heard.onText(REPLY, true);
    // A whole second of audio handed to the client the instant it was
    // synthesized: the ear is still at zero.
    heard.onAudio(chunk(1000));
    expect(heard.heard().chars).toBe(0);
  });

  test("the lag is subtracted, so a cut inside it heard nothing", () => {
    const { heard, clock } = setup(750);
    heard.startReply();
    heard.onText(REPLY, true);
    heard.onAudio(chunk(1000));
    clock.advance(500);
    // 500ms of playback, 750ms of network + jitter buffer behind it.
    expect(heard.heard().chars).toBe(0);
    clock.advance(400); // 900ms elapsed → 150ms audible
    expect(heard.heard().chars).toBeGreaterThan(0);
  });

  test("with no word timeline it is a proportional estimate, snapped back to a word", () => {
    const { heard, clock } = setup();
    heard.startReply();
    heard.onText(REPLY, true);
    heard.onAudio(chunk(1000));
    clock.advance(500);
    // Half of 18 characters is mid-word ("Hello the"), so the cut moves back.
    expect(heard.heard().text).toBe("Hello");
  });

  test("a word whose audio is only half elapsed does NOT count", () => {
    const { heard, clock } = setup();
    heard.startReply();
    heard.onText(REPLY, true);
    heard.onAudio(chunk(1000));
    heard.onWords(WORDS);
    clock.advance(600); // "there" started at 400 and ends at 800
    expect(heard.heard().text).toBe("Hello");
    clock.advance(200); // now it has wholly elapsed
    expect(heard.heard().text).toBe("Hello there");
  });

  test("word timings beat the proportional estimate where the two disagree", () => {
    const words = setup();
    const plain = setup();
    for (const t of [words, plain]) {
      t.heard.startReply();
      t.heard.onText(REPLY, true);
      // Padding: the first word's audio occupies most of the second, which is
      // exactly the per-flush padding a character-proportional cut cannot model.
      t.heard.onAudio(chunk(1000));
      t.clock.advance(900);
    }
    words.heard.onWords([{ text: "Hello", startMs: 0, endMs: 950 }]);
    // The service padded one word into most of a second, so at 900ms the
    // caller has not finished hearing even the first word — while the
    // proportional estimate, which cannot model padding, claims two.
    expect(words.heard.heard().text).toBe("");
    expect(plain.heard.heard().text).toBe("Hello there");
  });

  test("a partial timeline is authoritative for its prefix and proportional beyond it", () => {
    const { heard, clock } = setup();
    heard.startReply();
    heard.onText(REPLY, true);
    heard.onAudio(chunk(1000));
    // Only the first word was reported; the rest of the reply has no timings.
    heard.onWords([WORDS[0] as TtsWordTiming]);
    clock.advance(900);
    // Past the last reported word the estimate takes over — and never falls
    // below what the words already established.
    expect(heard.heard().text).toBe("Hello there");
  });

  test("text still queued for synthesis is not counted as heard", () => {
    // THE over-keeping bias this module exists to remove. `spoken` is
    // everything handed to TTS; `audioMs` is only what came back. An LLM
    // streaming far ahead of the voice makes their ratio an impossible speech
    // rate, and the old estimate believed it — reporting a whole reply as heard
    // while the caller was six seconds behind, writing the unheard remainder
    // into history as delivered and anchoring the resume prompt past it.
    const { heard, clock } = setup();
    heard.startReply();
    // 300 characters handed over at once; five seconds of audio has come back.
    heard.onText("word ".repeat(60), true);
    heard.onAudio(chunk(5000));
    clock.advance(5000);
    // At ~15 characters a second, five seconds is ~75 characters. The estimate
    // may not claim the whole reply, and must stay near what a voice can say.
    expect(heard.heard().chars).toBeLessThan(100);
    expect(heard.heard().chars).toBeGreaterThan(50);
  });

  test("a reply whose audio is complete is still tracked by its own rate", () => {
    // The other side of the clamp: once synthesis has finished, the observed
    // ratio IS the speech rate, and a deliberately slow voice must not be
    // credited with the ceiling's faster one.
    const { heard, clock } = setup();
    heard.startReply();
    heard.onText("Hello there friend", true); // 18 chars
    heard.onAudio(chunk(4000)); // ~4.5 chars/s: a very slow voice
    clock.advance(2000);
    // Half the audio played, so half the text — not the 36 characters a
    // ceiling-rate estimate would claim, and not the whole reply.
    expect(heard.heard().text).toBe("Hello");
  });

  test("a word the provider renamed degrades to the estimate rather than to nothing", () => {
    const { heard, clock } = setup();
    heard.startReply();
    heard.onText("You owe $5.00 today", true);
    heard.onAudio(chunk(1000));
    heard.onWords([{ text: "five dollars", startMs: 0, endMs: 500 }]);
    clock.advance(1000);
    // "five dollars" is nowhere in the text, so alignment fails — the answer is
    // the proportional estimate, not an empty record.
    expect(heard.heard().text.length).toBeGreaterThan(0);
    expect("You owe $5.00 today").toContain(heard.heard().text);
  });
});

describe("createHeardTracker — what may be recorded", () => {
  test("filler inside the heard prefix is audible but never recordable", () => {
    const { heard, clock } = setup();
    heard.startReply();
    heard.onText("Sure, ", true);
    heard.onText("One moment. ", false); // dead-air cover
    heard.onText("here it is.", true);
    // 29 characters over two seconds — a natural pace. A shorter chunk would
    // put the fixture above any real speech rate, where the estimate clamps
    // (see MAX_SPEECH_CHARS_PER_MS) and this spec would be measuring that
    // instead of the filler split it is about.
    heard.onAudio(chunk(2000));
    clock.advance(1720);
    const at = heard.heard();
    // The caller heard through "here it", filler included...
    expect(at.chars).toBe(25);
    // ...and the record is the model's words only, contiguous, so it indexes
    // the turn's `accumulated` string as a real prefix.
    expect(at.text).toBe("Sure, here it");
    expect(at.recordableChars).toBe(at.text.length);
    expect("Sure, here it is.").toContain(at.text);
  });
});

describe("createHeardTracker — the latch", () => {
  test("cut() latches the position, so a later read is unaffected by the reset", () => {
    const { heard, clock } = setup();
    heard.startReply();
    heard.onText(REPLY, true);
    heard.onAudio(chunk(1000));
    clock.advance(500);
    const atCut = heard.heard();
    heard.cut();
    // The abort restarts the playback clock and the interrupted turn's
    // persistence runs later — an unlatched read would report the whole reply
    // as heard, which is the bug the latch exists for.
    clock.advance(5000);
    expect(heard.heard()).toEqual(atCut);
  });

  test("the next reply clears the latch", () => {
    const { heard, clock } = setup();
    heard.startReply();
    heard.onText(REPLY, true);
    heard.onAudio(chunk(1000));
    clock.advance(1000);
    heard.cut();
    expect(heard.heard().chars).toBeGreaterThan(0);
    heard.startReply();
    expect(heard.heard().chars).toBe(0);
  });
});

describe("createHeardTracker — the clock is session-scoped", () => {
  test("a reply queued behind the last one's audio starts at zero heard", () => {
    const { heard, clock } = setup();
    heard.startReply();
    heard.onText("first reply here", true);
    heard.onAudio(chunk(1000));
    // Reply two is synthesized while reply one is still playing out.
    heard.startReply();
    heard.onText(REPLY, true);
    heard.onAudio(chunk(1000));
    // Rebasing the clock here would claim the caller had heard reply two
    // already; they are still listening to reply one.
    expect(heard.heard().chars).toBe(0);
    clock.advance(1000);
    expect(heard.heard().chars).toBe(0);
    clock.advance(1000);
    expect(heard.heard().text).toBe(REPLY);
  });

  test("pending() keeps its own grace, later than the heard cursor", () => {
    const { heard, clock } = setup();
    heard.startReply();
    heard.onText(REPLY, true);
    heard.onAudio(chunk(1000));
    clock.advance(1000);
    // Everything is heard, and barge-in still works: the grace covers the
    // network + jitter tail the heard cursor deliberately does not.
    expect(heard.heard().text).toBe(REPLY);
    expect(heard.pending()).toBe(true);
    clock.advance(1000);
    expect(heard.pending()).toBe(false);
  });
});

// The clock above is OPEN-LOOP: it assumes a forwarded chunk starts playing on
// arrival at exactly 1.0x. A client that drains slower accrues a backlog the
// host cannot see, and every consumer of the estimate then fails together —
// measured against a harness draining at 0.60-0.67x, the host called the line
// silent while the client still held 3.8-7.3s of the reply. `playback_progress`
// is the one closed-loop input that corrects it.
describe("createHeardTracker — the client's playback report", () => {
  test("extends a clock that ran ahead of a slow client", () => {
    const { heard, clock } = setup();
    heard.startReply();
    heard.onText(REPLY, true);
    heard.onAudio(chunk(1000));
    clock.advance(1000);
    // Open-loop: one second of audio, one second elapsed, so the host believes
    // playback finished and the whole reply was heard.
    expect(heard.heard().text).toBe(REPLY);
    // The client says otherwise — it is still holding 800ms of it.
    heard.onClientPlaybackReport(800);
    expect(heard.heard().text).not.toBe(REPLY);
    expect(heard.pending()).toBe(true);
    clock.advance(800);
    expect(heard.heard().text).toBe(REPLY);
  });

  test("clamps upward only, so a low or stale report cannot retire audio early", () => {
    const { heard, clock } = setup();
    heard.startReply();
    heard.onText(REPLY, true);
    heard.onAudio(chunk(1000));
    // The host's own estimate says a full second is outstanding. A report of
    // 10ms — a lagging client, a dropped frame, a buggy one — must not shorten
    // it: the downward direction is what would write unheard words into
    // history as delivered.
    heard.onClientPlaybackReport(10);
    expect(heard.heard().text).toBe("");
    expect(heard.pending()).toBe(true);
    clock.advance(1000);
    expect(heard.heard().text).toBe(REPLY);
  });

  test("a client that never reports behaves exactly as before", () => {
    const quiet = setup();
    const reporting = setup();
    for (const { heard } of [quiet, reporting]) {
      heard.startReply();
      heard.onText(REPLY, true);
      heard.onAudio(chunk(1000));
    }
    // A report matching what the host already believes is a no-op, which is
    // what makes the frame safe to adopt incrementally: an old client and a
    // new one on a real-time link land in the same place.
    reporting.heard.onClientPlaybackReport(1000);
    quiet.clock.advance(400);
    reporting.clock.advance(400);
    expect(reporting.heard.heard().text).toBe(quiet.heard.heard().text);
  });

  test("a report never inflates the reply's own length", () => {
    const { heard, clock } = setup();
    heard.startReply();
    heard.onText(REPLY, true);
    heard.onAudio(chunk(1000));
    // Absurd backlog: only the CLOCK may move. If it fed the reply's audio
    // length too, the cursor could run past text that was never synthesized.
    heard.onClientPlaybackReport(60_000);
    clock.advance(120_000);
    expect(heard.heard().text).toBe(REPLY);
    expect(heard.pending()).toBe(false);
  });
});

describe("createHeardTracker — the resume prompt", () => {
  test("quotes the heard text, which is what history records", () => {
    const { heard, clock } = setup();
    heard.startReply();
    heard.onText("Your balance is five hundred dollars and change", true);
    heard.onAudio(chunk(4000));
    clock.advance(1000);
    const prompt = heard.resumePrompt() ?? "";
    const anchor = prompt.match(/"…(.*)"/)?.[1] ?? "";
    expect(anchor.length).toBeGreaterThan(0);
    expect(heard.heard().text.trimEnd().endsWith(anchor)).toBe(true);
  });

  test("nothing heard asks for the reply again", () => {
    const { heard } = setup();
    heard.startReply();
    heard.onText("Your balance is five hundred dollars", true);
    heard.onAudio(chunk(4000));
    expect(heard.resumePrompt()).toContain("Give that reply again");
  });

  test("a reply the caller had essentially finished hearing arms nothing", () => {
    const { heard, clock } = setup();
    heard.startReply();
    heard.onText("Your balance is five hundred dollars", true);
    heard.onAudio(chunk(4000));
    clock.advance(3600); // under TAIL_RESUME_MIN_UNHEARD_MS left
    expect(heard.resumePrompt()).toBeUndefined();
  });

  test("filler never becomes the anchor", () => {
    const { heard, clock } = setup();
    heard.startReply();
    heard.onText("Let me check that for you. ", true);
    heard.onText("Still working on that.", false);
    heard.onAudio(chunk(4000));
    clock.advance(2000);
    expect(heard.resumePrompt()).not.toContain("Still working");
  });
});
