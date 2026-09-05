// Copyright 2026 the AAI authors. MIT license.
/**
 * The pacer's job is to stop a reply from being dumped into the client socket
 * faster than it can possibly be played. The tests below pin the two halves of
 * that: audio flows freely up to a bounded lead, and everything after it is
 * released on a clock — plus the ordering rules pacing introduces, since
 * `audio_done` overtaking still-queued audio would truncate the reply and a
 * barge-in must discard what is held.
 */

import {
  CLIENT_AUDIO_LEAD_MS,
  HEARD_AUDIO_LAG_MS,
  PACER_BURST_MS,
  PIPELINE_PLAYBACK_GRACE_MS,
  PLAYBACK_FILL_MS,
} from "@alexkroman1/aai/internal";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createAudioPacer, UNPACED_AUDIO_LEAD_MS } from "./audio-pacer.ts";

const SAMPLE_RATE = 24_000;
/** 24 kHz PCM16 is 48 bytes/ms, so this is exactly 100ms of audio. */
const CHUNK_BYTES = 4800;

function makePacer(leadMs = 1000) {
  const audio: number[] = [];
  const dones: number[] = [];
  const pacer = createAudioPacer({
    sendAudio: (chunk) => audio.push(chunk.byteLength),
    sampleRate: SAMPLE_RATE,
    leadMs,
  });
  // `pushDone` is gone: the turn's `audio.completed` is an ordinary event now, so
  // the sink queues it through `pushAfterAudio` like any other end-of-turn frame.
  // Same ordering under test, one less way to enqueue one.
  const pushDone = () => {
    pacer.pushAfterAudio(() => dones.push(Date.now()));
  };
  return { pacer, audio, dones, pushDone };
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

  test("the burst dip leaves the client's fill target intact", () => {
    // The burst wake lets the lead sag to CLIENT_AUDIO_LEAD_MS -
    // PACER_BURST_MS; that dip is cushion the client temporarily doesn't
    // have, so it must stay above the playback worklet's fill target — above
    // which the target can never be met and the reply would not start until
    // 'done' arrived.
    expect(CLIENT_AUDIO_LEAD_MS - PACER_BURST_MS).toBeGreaterThan(PLAYBACK_FILL_MS);
  });

  test("the heard cursor's ear-lag is NOT derived from the lead", () => {
    // This reads like a missing coupling and is the opposite. Both this pacer's
    // lead and the playback clock in `pipeline-heard.ts` accumulate from
    // `max(previous, now())`, so `remainingMs()` already tracks whatever lead is
    // set here — the client's buffer depth is subtracted from the heard cursor
    // before HEARD_AUDIO_LAG_MS is applied at all. Measured
    // (`aai-ui/worklets/playback-tuning.test.ts`), the cursor's error is
    // identical at leads of 1000, 1500 and 2000 ms.
    //
    // Two derivations have been wrong here in the same direction, the second one
    // briefly shipped: `PLAYBACK_JITTER_MS + hop`, then
    // `CLIENT_AUDIO_LEAD_MS - PACER_BURST_MS / 2`. Both sized the term against
    // the buffer depth, double-counting it, leaving the cursor ~694 ms and then
    // ~894 ms early. So this asserts the ear-lag stays SMALL and independent —
    // it is the network hop and nothing else.
    expect(HEARD_AUDIO_LAG_MS).toBeLessThan(CLIENT_AUDIO_LEAD_MS / 4);
    expect(HEARD_AUDIO_LAG_MS).toBeLessThan(PIPELINE_PLAYBACK_GRACE_MS);
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
    const { pacer, audio, dones, pushDone } = makePacer();
    pushChunks(pacer, 15);
    pushDone();

    // audio_done arriving before the tail would make the client's worklet
    // treat the turn as finished and drop the rest of the reply.
    expect(dones).toHaveLength(0);

    vi.advanceTimersByTime(900);
    expect(audio).toHaveLength(15);
    expect(dones).toHaveLength(1);
    pacer.stop();
  });

  test("keeps an end-of-reply frame behind the audio it closes", () => {
    const { pacer, audio } = makePacer();
    const frames: number[] = [];
    pushChunks(pacer, 15);
    pacer.pushAfterAudio(() => frames.push(audio.length));

    // A `reply_done` that overtakes the tail tells the client the turn is over
    // while seconds of it are still in the queue here — everything after it
    // then belongs, as far as the client can tell, to the next reply.
    expect(frames).toHaveLength(0);

    vi.advanceTimersByTime(900);
    expect(frames).toEqual([15]);
    pacer.stop();
  });

  test("an unpaced client gets every frame as it arrives", () => {
    // A programmatic client meters playback itself; holding audio to the wall
    // clock starves it instead of protecting it.
    const { pacer, audio, dones, pushDone } = makePacer(UNPACED_AUDIO_LEAD_MS);
    pushChunks(pacer, 50); // 5s of audio against a 1s real-time lead
    pushDone();
    expect(audio).toHaveLength(50);
    expect(dones).toHaveLength(1);
    pacer.stop();
  });

  test("sends audio_done immediately when nothing is queued behind it", () => {
    const { pacer, dones, pushDone } = makePacer();
    pushChunks(pacer, 2);
    pushDone();
    expect(dones).toHaveLength(1);
    pacer.stop();
  });

  test("clear drops held audio and a pending done", () => {
    const { pacer, audio, dones, pushDone } = makePacer();
    pushChunks(pacer, 15);
    pushDone();
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
