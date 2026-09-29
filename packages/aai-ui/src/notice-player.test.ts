// Copyright 2026 the AAI authors. MIT license.
/**
 * The notice player over a fake context: what reaches the buffer (PCM16LE
 * scaled to [-1, 1) at 16 kHz), that `unlock()` is what resumes a suspended
 * context (the autoplay rule the player exists around), and that `stop()` and
 * `close()` silence what is playing.
 */

import { describe, expect, type Mock, test, vi } from "vitest";
import {
  createNoticePlayer,
  NOTICE_SAMPLE_RATE,
  type NoticeAudioContext,
  type NoticeBuffer,
} from "./notice-player.ts";

/** A source as the player drives it, with the handler it sets callable as the browser calls it. */
type FakeSource = {
  buffer: NoticeBuffer | null;
  onended: (() => unknown) | null;
  connect: Mock<(destination: unknown) => unknown>;
  start: Mock<() => void>;
  stop: Mock<() => void>;
};

function fakeContext(state: AudioContextState = "suspended") {
  const sources: FakeSource[] = [];
  const buffers: { rate: number; samples: Float32Array }[] = [];
  const ctx: NoticeAudioContext & { state: AudioContextState } = {
    state,
    destination: {},
    resume: vi.fn(async () => {
      ctx.state = "running";
    }),
    close: vi.fn(async () => undefined),
    createBuffer: (_channels, length, rate) => {
      const samples = new Float32Array(length);
      buffers.push({ rate, samples });
      return { getChannelData: () => samples };
    },
    createBufferSource: () => {
      const src: FakeSource = {
        buffer: null,
        onended: null,
        connect: vi.fn<(destination: unknown) => unknown>(),
        start: vi.fn<() => void>(),
        stop: vi.fn<() => void>(),
      };
      sources.push(src);
      return src;
    },
  };
  return { ctx, sources, buffers, asContext: () => ctx };
}

describe("createNoticePlayer", () => {
  test("unlock() makes and resumes the context — from the gesture, not later", () => {
    const fake = fakeContext();
    const make = vi.fn(fake.asContext);
    const player = createNoticePlayer(make);
    expect(make).not.toHaveBeenCalled();
    player.unlock();
    expect(make).toHaveBeenCalledOnce();
    expect(fake.ctx.resume).toHaveBeenCalledOnce();
  });

  test("plays PCM16LE mono at 16 kHz, scaled to [-1, 1)", () => {
    const fake = fakeContext("running");
    const player = createNoticePlayer(fake.asContext);
    // 0x4000 = 16384 → 0.5; 0x8000 = -32768 → -1.
    player.play(new Uint8Array([0x00, 0x40, 0x00, 0x80]));
    const [buffer] = fake.buffers;
    expect(buffer?.rate).toBe(NOTICE_SAMPLE_RATE);
    expect([...(buffer?.samples ?? [])]).toEqual([0.5, -1]);
    expect(fake.sources[0]?.start).toHaveBeenCalledOnce();
  });

  test("empty audio plays nothing and makes no context", () => {
    const make = vi.fn(fakeContext().asContext);
    createNoticePlayer(make).play(new Uint8Array(0));
    expect(make).not.toHaveBeenCalled();
  });

  test("stop() silences what is playing, and a finished notice is not stopped again", () => {
    const fake = fakeContext("running");
    const player = createNoticePlayer(fake.asContext);
    player.play(new Uint8Array([1, 0]));
    player.play(new Uint8Array([2, 0]));
    fake.sources[0]?.onended?.();
    player.stop();
    expect(fake.sources[0]?.stop).not.toHaveBeenCalled();
    expect(fake.sources[1]?.stop).toHaveBeenCalledOnce();
  });

  test("close() releases the context, and the next play makes a new one", () => {
    const first = fakeContext("running");
    const second = fakeContext("running");
    const make = vi
      .fn()
      .mockReturnValueOnce(first.asContext())
      .mockReturnValueOnce(second.asContext());
    const player = createNoticePlayer(make);
    player.play(new Uint8Array([1, 0]));
    player.close();
    expect(first.ctx.close).toHaveBeenCalledOnce();
    expect(first.sources[0]?.stop).toHaveBeenCalledOnce();
    player.play(new Uint8Array([1, 0]));
    expect(second.sources).toHaveLength(1);
  });

  test("with no AudioContext at all it is silent rather than throwing", () => {
    const player = createNoticePlayer(undefined);
    expect(() => {
      player.unlock();
      player.play(new Uint8Array([1, 0]));
      player.close();
    }).not.toThrow();
  });
});
