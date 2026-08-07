// Copyright 2026 the AAI authors. MIT license.
// Specs for the `WordBoundaries` parse and the turn-timeline rebase. The wire
// shape is not verified against the live service (see the module doc), so BOTH
// candidate shapes get a fixture: whichever a capture confirms is already
// covered, and the unknown one costs a few lines rather than a re-design.

import { describe, expect, test } from "vitest";
import { createWordTimeline, readWordBoundaries } from "./assemblyai-words.ts";

describe("readWordBoundaries", () => {
  test("reads a batch of words", () => {
    const frame = {
      type: "WordBoundaries",
      words: [
        { text: "Your", audio_start_ms: 0, audio_end_ms: 200 },
        { text: "balance", audio_start_ms: 200, audio_end_ms: 640 },
      ],
    };
    expect(readWordBoundaries(frame)).toEqual([
      { text: "Your", startMs: 0, endMs: 200 },
      { text: "balance", startMs: 200, endMs: 640 },
    ]);
  });

  test("reads a single top-level word", () => {
    const frame = { type: "WordBoundaries", text: "Your", audio_start_ms: 880, audio_end_ms: 1100 };
    expect(readWordBoundaries(frame)).toEqual([{ text: "Your", startMs: 880, endMs: 1100 }]);
  });

  test("a word with only a start is instantaneous rather than dropped", () => {
    const frame = { type: "WordBoundaries", words: [{ word: "Your", start_ms: 400 }] };
    expect(readWordBoundaries(frame)).toEqual([{ text: "Your", startMs: 400, endMs: 400 }]);
  });

  test.each([
    ["null", null],
    ["a string", "WordBoundaries"],
    ["no words at all", { type: "WordBoundaries" }],
    ["a word with no timing", { type: "WordBoundaries", words: [{ text: "Your" }] }],
    ["a word with no text", { type: "WordBoundaries", words: [{ audio_start_ms: 0 }] }],
    ["words that are not objects", { type: "WordBoundaries", words: [1, "two", null] }],
    ["a non-finite offset", { type: "WordBoundaries", words: [{ text: "a", start: Number.NaN }] }],
  ])("an unreadable frame (%s) yields [] and never throws", (_label, frame) => {
    // A malformed frame must never kill the session: word timings are a
    // history nicety and the consumer degrades to a proportional estimate.
    expect(() => readWordBoundaries(frame)).not.toThrow();
    expect(readWordBoundaries(frame)).toEqual([]);
  });

  test("an end before its start is clamped, never negative-length", () => {
    const frame = { type: "WordBoundaries", words: [{ text: "a", start_ms: 500, end_ms: 100 }] };
    expect(readWordBoundaries(frame)).toEqual([{ text: "a", startMs: 500, endMs: 500 }]);
  });
});

describe("createWordTimeline", () => {
  test("the first frame of a turn anchors at zero", () => {
    const timeline = createWordTimeline();
    // A per-socket cumulative clock: this turn's audio starts 12s into the
    // socket's life, and the transport's cursor counts from the turn.
    expect(
      timeline.rebase([
        { text: "Your", startMs: 12_000, endMs: 12_200 },
        { text: "balance", startMs: 12_200, endMs: 12_640 },
      ]),
    ).toEqual([
      { text: "Your", startMs: 0, endMs: 200 },
      { text: "balance", startMs: 200, endMs: 640 },
    ]);
  });

  test("a per-flush clock restart re-anchors at the previous last end", () => {
    const timeline = createWordTimeline();
    timeline.rebase([{ text: "Your", startMs: 0, endMs: 880 }]);
    // Second segment, whose offsets start from zero again — the shape the
    // per-flush padding measurement in assemblyai-segment.ts describes.
    expect(timeline.rebase([{ text: "balance", startMs: 0, endMs: 800 }])).toEqual([
      { text: "balance", startMs: 880, endMs: 1680 },
    ]);
  });

  test("a cumulative clock keeps accumulating across frames", () => {
    const timeline = createWordTimeline();
    timeline.rebase([{ text: "Your", startMs: 100, endMs: 980 }]);
    expect(timeline.rebase([{ text: "balance", startMs: 980, endMs: 1780 }])).toEqual([
      { text: "balance", startMs: 880, endMs: 1680 },
    ]);
  });

  test("words are clamped monotone, so a reordered frame cannot rewind the cursor", () => {
    const timeline = createWordTimeline();
    const out = timeline.rebase([
      { text: "one", startMs: 0, endMs: 400 },
      { text: "two", startMs: 200, endMs: 300 },
    ]);
    expect(out.map((w) => w.startMs)).toEqual([0, 400]);
    expect(out.map((w) => w.endMs)).toEqual([400, 400]);
  });

  test("reset() re-anchors the next turn at zero", () => {
    const timeline = createWordTimeline();
    timeline.rebase([{ text: "Your", startMs: 0, endMs: 880 }]);
    timeline.reset();
    expect(timeline.rebase([{ text: "Sure", startMs: 5000, endMs: 5300 }])).toEqual([
      { text: "Sure", startMs: 0, endMs: 300 },
    ]);
  });

  test("an empty frame changes nothing", () => {
    const timeline = createWordTimeline();
    expect(timeline.rebase([])).toEqual([]);
    expect(timeline.rebase([{ text: "Your", startMs: 400, endMs: 600 }])).toEqual([
      { text: "Your", startMs: 0, endMs: 200 },
    ]);
  });
});
