// Copyright 2026 the AAI authors. MIT license.
/**
 * The pacer's job is to stop a reply from being dumped into the client socket
 * faster than it can possibly be played. The tests below pin the two halves of
 * that: audio flows freely up to a bounded lead, and everything after it is
 * released on a clock — plus the ordering rules pacing introduces, since
 * `audio_done` overtaking still-queued audio would truncate the reply and a
 * barge-in must discard what is held.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createAudioPacer } from "./audio-pacer.ts";

const SAMPLE_RATE = 24_000;
/** 24 kHz PCM16 is 48 bytes/ms, so this is exactly 100ms of audio. */
const CHUNK_BYTES = 4800;

function makePacer(leadMs = 1000) {
  const audio: number[] = [];
  const dones: number[] = [];
  const pacer = createAudioPacer({
    sendAudio: (chunk) => audio.push(chunk.byteLength),
    sendDone: () => dones.push(Date.now()),
    sampleRate: SAMPLE_RATE,
    leadMs,
  });
  return { pacer, audio, dones };
}

/** Push `count` 100ms chunks. */
function pushChunks(pacer: ReturnType<typeof makePacer>["pacer"], count: number): void {
  for (let i = 0; i < count; i++) pacer.push(new Uint8Array(CHUNK_BYTES));
}

describe("createAudioPacer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("sends audio immediately while the lead is unmet", () => {
    const { pacer, audio } = makePacer();
    pushChunks(pacer, 3); // 300ms, well inside a 1000ms lead
    expect(audio).toHaveLength(3);
    pacer.stop();
  });

  test("holds audio once the bounded lead is reached", () => {
    const { pacer, audio } = makePacer();
    pushChunks(pacer, 15); // 1500ms of audio against a 1000ms lead
    // The 11th chunk is the one that crosses the lead, so it still goes out;
    // everything past it waits. Without this the whole 1500ms would land in
    // the socket buffer at once.
    expect(audio).toHaveLength(11);
    pacer.stop();
  });

  test("releases held audio in bursts as the lead drains", () => {
    const { pacer, audio } = makePacer();
    pushChunks(pacer, 15);
    expect(audio).toHaveLength(11);

    // Burst release: nothing goes out until the lead has drained
    // PACER_BURST_MS below the ceiling, then the drained span's worth of
    // frames goes out in one wakeup — not one timer fire per frame.
    vi.advanceTimersByTime(100);
    expect(audio).toHaveLength(11);

    vi.advanceTimersByTime(200);
    expect(audio.length).toBeGreaterThanOrEqual(13);

    vi.advanceTimersByTime(600);
    expect(audio).toHaveLength(15);
    pacer.stop();
  });

  test("keeps audio_done behind the audio it follows", () => {
    const { pacer, audio, dones } = makePacer();
    pushChunks(pacer, 15);
    pacer.pushDone();

    // audio_done arriving before the tail would make the client's worklet
    // treat the turn as finished and drop the rest of the reply.
    expect(dones).toHaveLength(0);

    vi.advanceTimersByTime(900);
    expect(audio).toHaveLength(15);
    expect(dones).toHaveLength(1);
    pacer.stop();
  });

  test("sends audio_done immediately when nothing is queued behind it", () => {
    const { pacer, dones } = makePacer();
    pushChunks(pacer, 2);
    pacer.pushDone();
    expect(dones).toHaveLength(1);
    pacer.stop();
  });

  test("clear drops held audio and a pending done", () => {
    const { pacer, audio, dones } = makePacer();
    pushChunks(pacer, 15);
    pacer.pushDone();
    const sentBeforeClear = audio.length;

    // Barge-in: the client discards its own buffer, so held audio for the
    // dead turn must never arrive — it would play as an orphan fragment.
    pacer.clear();
    vi.advanceTimersByTime(5000);

    expect(audio).toHaveLength(sentBeforeClear);
    expect(dones).toHaveLength(0);
    pacer.stop();
  });

  test("a new turn after clear starts with a full lead again", () => {
    const { pacer, audio } = makePacer();
    pushChunks(pacer, 15);
    pacer.clear();
    audio.length = 0;

    pushChunks(pacer, 15);
    expect(audio).toHaveLength(11);
    pacer.stop();
  });

  test("stop discards held audio and cancels the timer", () => {
    const { pacer, audio } = makePacer();
    pushChunks(pacer, 15);
    const sentBeforeStop = audio.length;

    pacer.stop();
    pushChunks(pacer, 5);
    vi.advanceTimersByTime(5000);

    expect(audio).toHaveLength(sentBeforeStop);
  });

  test("a lead-sized gap between turns does not delay the next turn", () => {
    const { pacer, audio } = makePacer();
    pushChunks(pacer, 11);
    expect(audio).toHaveLength(11);

    // The reply finished playing long ago; the stale playout clock must not
    // make the next turn's first chunk wait.
    vi.advanceTimersByTime(30_000);
    pushChunks(pacer, 1);
    expect(audio).toHaveLength(12);
    pacer.stop();
  });
});
