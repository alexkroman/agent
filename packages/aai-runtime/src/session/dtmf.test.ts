// Copyright 2026 the AAI authors. MIT license.

import type { ClientSink } from "@alexkroman1/aai/protocol";
import { describe, expect, test } from "vitest";
import { bytesToPcm16 } from "../_pcm.ts";
import { mulawToPcm16, pcm16ToMulaw, TELEPHONY_SAMPLE_RATE } from "../telephony/mulaw.ts";
import { createResampler } from "../telephony/resample.ts";
import {
  DTMF_GAP_MS,
  DTMF_PAUSE_MS,
  DTMF_TONE_MS,
  dtmfFrames,
  dtmfSender,
  dtmfTones,
} from "./dtmf.ts";

const ROWS = [697, 770, 852, 941];
const COLS = [1209, 1336, 1477, 1633];
const PAD = ["123A", "456B", "789C", "*0#D"];

/** Goertzel power of `hz` over `pcm`. */
function power(pcm: Int16Array, hz: number, rate: number): number {
  const coeff = 2 * Math.cos((2 * Math.PI * hz) / rate);
  let prev = 0;
  let prev2 = 0;
  for (const sample of pcm) {
    const next = sample / 32_768 + coeff * prev - prev2;
    prev2 = prev;
    prev = next;
  }
  return prev * prev + prev2 * prev2 - coeff * prev * prev2;
}

/** The key a receiver would read from one tone window: the strongest row and column. */
function decodeKey(pcm: Int16Array, rate: number): string {
  const strongest = (group: number[]) =>
    group.reduce(
      (best, hz, i) => (power(pcm, hz, rate) > power(pcm, group[best] ?? 0, rate) ? i : best),
      0,
    );
  return PAD[strongest(ROWS)]?.[strongest(COLS)] ?? "?";
}

/** Each key's tone window, decoded, at `rate`. */
function decodeAll(pcm: Int16Array, keys: number, rate: number): string {
  const step = Math.round(((DTMF_TONE_MS + DTMF_GAP_MS) * rate) / 1000);
  const tone = Math.round((DTMF_TONE_MS * rate) / 1000);
  let out = "";
  for (let k = 0; k < keys; k++) out += decodeKey(pcm.subarray(k * step, k * step + tone), rate);
  return out;
}

describe("dtmfTones", () => {
  test("every key on the pad decodes as itself", () => {
    const keys = PAD.join("");
    expect(decodeAll(dtmfTones(keys, 16_000), keys.length, 16_000)).toBe(keys);
  });

  test("is one tone plus one gap per key, and a w is a half-second of silence", () => {
    const rate = 8000;
    const perKey = ((DTMF_TONE_MS + DTMF_GAP_MS) * rate) / 1000;
    expect(dtmfTones("12", rate)).toHaveLength(2 * perKey);
    const paused = dtmfTones("w1", rate);
    expect(paused).toHaveLength((DTMF_PAUSE_MS * rate) / 1000 + perKey);
    expect(paused.subarray(0, (DTMF_PAUSE_MS * rate) / 1000).every((s) => s === 0)).toBe(true);
  });

  test("never clips, and ramps in from silence", () => {
    const pcm = dtmfTones("D", 24_000);
    expect(Math.max(...pcm.map(Math.abs))).toBeLessThan(32_767 * 0.6);
    expect(pcm[0]).toBe(0);
  });

  test("survive the phone path: 24 kHz TTS rate, resampled to 8 kHz, through μ-law", () => {
    // What the telephony bridge does to every agent frame on its way to a carrier.
    const keys = "159#0*";
    const resampler = createResampler(24_000, TELEPHONY_SAMPLE_RATE);
    const eightKhz = resampler.process(dtmfTones(keys, 24_000));
    const line = mulawToPcm16(pcm16ToMulaw(eightKhz));
    expect(decodeAll(line, keys.length, TELEPHONY_SAMPLE_RATE)).toBe(keys);
  });
});

describe("dtmfFrames", () => {
  test("cuts the tones into 20 ms PCM16 frames that add back up to them", () => {
    const frames = dtmfFrames("1", 16_000);
    expect(frames.slice(0, -1).every((f) => f.byteLength === 640)).toBe(true);
    const joined = frames.flatMap((f) => [...bytesToPcm16(f)]);
    expect(joined).toEqual([...dtmfTones("1", 16_000)]);
  });
});

describe("dtmfSender", () => {
  function sink(open: boolean): ClientSink & { audio: Uint8Array[] } {
    const audio: Uint8Array[] = [];
    return { open, audio, event: () => undefined, playAudioChunk: (c) => audio.push(c) };
  }

  test("plays the keys' frames on the sink", () => {
    const client = sink(true);
    dtmfSender(client, 16_000)("1");
    expect(client.audio).toEqual(dtmfFrames("1", 16_000));
  });

  test("plays nothing into a closed sink", () => {
    const client = sink(false);
    dtmfSender(client, 16_000)("1");
    expect(client.audio).toEqual([]);
  });
});
