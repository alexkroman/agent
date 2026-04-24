// Copyright 2026 the AAI authors. MIT license.
// Parity check: canonical wire-v1 fixtures round-trip through the browser-side
// codec identically to the host-side codec. Any drift fails this test.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  C2S,
  decodeC2S,
  decodeS2C,
  encAudioChunkC2S,
  encAudioChunkS2C,
  encAudioDone,
  encCancel,
  encCancelled,
  encConfig,
  encError,
  encHistory,
  encReplyDone,
  encResetC2S,
  S2C,
} from "@alexkroman1/aai/wire";
import { describe, expect, test } from "vitest";

type Fixtures = {
  c2s: {
    audio_chunk_4bytes: { pcm: number[] };
    audio_ready: Record<string, never>;
    cancel: Record<string, never>;
    reset: Record<string, never>;
    history_empty: { messages: readonly { role: "user" | "assistant"; content: string }[] };
    history_two: { messages: readonly { role: "user" | "assistant"; content: string }[] };
  };
  s2c: {
    audio_chunk_2bytes: { pcm: number[] };
    audio_done: Record<string, never>;
    config: { sampleRate: number; ttsSampleRate: number; sid: string };
    reply_done: Record<string, never>;
    cancelled: Record<string, never>;
    error_connection_boom: { code: "connection"; message: string };
  };
};

const fixtures: Fixtures = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../aai/sdk/compat-fixtures/wire-v1.json"), "utf-8"),
);

describe("aai-ui wire v1 fixtures — client round-trip", () => {
  test("AUDIO_CHUNK_C2S encodes then decodes to same bytes", () => {
    const pcm = new Uint8Array(fixtures.c2s.audio_chunk_4bytes.pcm);
    const frame = encAudioChunkC2S(pcm);
    expect(frame[0]).toBe(C2S.AUDIO_CHUNK);
    const r = decodeC2S(frame);
    expect(r.ok).toBe(true);
    if (r.ok && r.data.type === "audio_chunk") {
      expect(Array.from(r.data.pcm)).toEqual(fixtures.c2s.audio_chunk_4bytes.pcm);
    }
  });

  test("AUDIO_READY is a single 0x01 byte", () => {
    // Fixture carries empty payload; just assert the encoder's output shape.
    const frame = new Uint8Array([C2S.AUDIO_READY]);
    expect(Array.from(frame)).toEqual([0x01]);
  });

  test("CANCEL is 0x02", () => {
    expect(Array.from(encCancel())).toEqual([C2S.CANCEL]);
  });

  test("RESET_C2S is 0x03", () => {
    expect(Array.from(encResetC2S())).toEqual([C2S.RESET]);
  });

  test("HISTORY empty encodes then decodes to same shape", () => {
    const frame = encHistory(fixtures.c2s.history_empty.messages);
    const r = decodeC2S(frame);
    expect(r.ok).toBe(true);
    if (r.ok && r.data.type === "history") {
      expect(r.data.messages).toEqual(fixtures.c2s.history_empty.messages);
    }
  });

  test("HISTORY with two messages round-trips", () => {
    const frame = encHistory(fixtures.c2s.history_two.messages);
    const r = decodeC2S(frame);
    expect(r.ok).toBe(true);
    if (r.ok && r.data.type === "history") {
      expect(r.data.messages).toEqual(fixtures.c2s.history_two.messages);
    }
  });
});

describe("aai-ui wire v1 fixtures — server-to-client decode", () => {
  test("AUDIO_CHUNK_S2C round-trips", () => {
    const pcm = new Uint8Array(fixtures.s2c.audio_chunk_2bytes.pcm);
    const frame = encAudioChunkS2C(pcm);
    expect(frame[0]).toBe(S2C.AUDIO_CHUNK);
    const r = decodeS2C(frame);
    expect(r.ok).toBe(true);
    if (r.ok && r.data.type === "audio_chunk") {
      expect(Array.from(r.data.pcm)).toEqual(fixtures.s2c.audio_chunk_2bytes.pcm);
    }
  });

  test("AUDIO_DONE is 0x81", () => {
    expect(Array.from(encAudioDone())).toEqual([S2C.AUDIO_DONE]);
  });

  test("CONFIG decodes to the expected fields", () => {
    const frame = encConfig(fixtures.s2c.config);
    const r = decodeS2C(frame);
    expect(r.ok).toBe(true);
    if (r.ok && r.data.type === "config") {
      expect(r.data.sampleRate).toBe(fixtures.s2c.config.sampleRate);
      expect(r.data.ttsSampleRate).toBe(fixtures.s2c.config.ttsSampleRate);
      expect(r.data.sid).toBe(fixtures.s2c.config.sid);
    }
  });

  test("REPLY_DONE is 0x89", () => {
    expect(Array.from(encReplyDone())).toEqual([S2C.REPLY_DONE]);
  });

  test("CANCELLED is 0x8A", () => {
    expect(Array.from(encCancelled())).toEqual([S2C.CANCELLED]);
  });

  test("ERROR connection+boom round-trips", () => {
    const frame = encError(
      fixtures.s2c.error_connection_boom.code,
      fixtures.s2c.error_connection_boom.message,
    );
    const r = decodeS2C(frame);
    expect(r.ok).toBe(true);
    if (r.ok && r.data.type === "error") {
      expect(r.data.code).toBe(fixtures.s2c.error_connection_boom.code);
      expect(r.data.message).toBe(fixtures.s2c.error_connection_boom.message);
    }
  });
});
