// Copyright 2026 the AAI authors. MIT license.
/**
 * Pre-connect capture (`openPreConnectCapture`) and its hand-over to
 * `createVoiceIO`: the buffer bound, the seamless adoption at a matching rate,
 * and the resample-and-flush at any other.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  type AudioMockContext,
  findWorkletNode,
  g,
  installAudioMocks,
  type MockAudioWorkletNode,
  voiceOpts,
} from "./_react-test-utils.ts";
import { createVoiceIO } from "./audio.ts";
import { openPreConnectCapture, resamplePcm16 } from "./audio-preconnect.ts";

/** A PCM16 chunk of `samples` samples, every one `value`. */
function chunk(samples: number, value = 1): ArrayBuffer {
  return new Int16Array(samples).fill(value).buffer;
}

/** The capture worklet posting one batch, as `capture-processor.ts` does. */
function capture(node: MockAudioWorkletNode, buffer: ArrayBuffer): void {
  node.port.simulateMessage({ event: "chunk", buffer });
}

function captureNodes(audio: AudioMockContext): MockAudioWorkletNode[] {
  return audio.workletNodes().filter((n) => n.name === "capture-processor");
}

describe("openPreConnectCapture", () => {
  let audio: AudioMockContext & { restore: () => void };
  beforeEach(() => {
    audio = installAudioMocks();
  });
  afterEach(() => {
    audio.restore();
  });

  const open = (maxSeconds = 10) =>
    openPreConnectCapture({ sampleRate: 16_000, captureWorkletSrc: "cap", maxSeconds });

  test("opens the mic at the guessed rate and starts capturing at once", async () => {
    const pre = await open();
    const node = findWorkletNode(audio.workletNodes(), "capture-processor");
    expect(node.ctx.sampleRate).toBe(16_000);
    expect(node.port.posted).toContainEqual({ event: "start" });
    await pre.close();
  });

  test("keeps the LATEST maxSeconds, so the buffer runs into the live stream", async () => {
    // 0.1 s at 16 kHz is 1600 samples; a 0.25 s cap holds two of them.
    const pre = await open(0.25);
    const node = findWorkletNode(audio.workletNodes(), "capture-processor");
    for (const v of [1, 2, 3, 4]) capture(node, chunk(1600, v));

    const flushed: ArrayBuffer[][] = [];
    pre.handOff({ onBuffered: (c) => flushed.push(c), onChunk: vi.fn() });
    expect(flushed).toHaveLength(1);
    expect(flushed[0]?.map((b) => new Int16Array(b)[0])).toEqual([3, 4]);
    await pre.close();
  });

  test("hands off synchronously: the buffer first, then every later frame", async () => {
    const pre = await open();
    const node = findWorkletNode(audio.workletNodes(), "capture-processor");
    capture(node, chunk(4, 1));

    const order: string[] = [];
    pre.handOff({
      onBuffered: (c) => order.push(`buffered:${c.length}`),
      onChunk: () => order.push("live"),
    });
    capture(node, chunk(4, 2));
    expect(order).toEqual(["buffered:1", "live"]);
    await pre.close();
  });

  test("replays a dead-mic report that fired before the hand-off", async () => {
    const pre = await open();
    findWorkletNode(audio.workletNodes(), "capture-processor").port.simulateMessage({
      event: "silent",
    });
    const onSilent = vi.fn();
    pre.handOff({ onBuffered: vi.fn(), onChunk: vi.fn(), onSilent });
    expect(onSilent).toHaveBeenCalledOnce();
    await pre.close();
  });

  test("close() stops the stream and the context", async () => {
    const stop = vi.fn();
    const nav = g.navigator as { mediaDevices: { getUserMedia: unknown } };
    nav.mediaDevices.getUserMedia = () => Promise.resolve({ getTracks: () => [{ stop }] });
    const pre = await open();
    await pre.close();
    expect(stop).toHaveBeenCalled();
    expect(audio.lastContext().closed).toBe(true);
  });

  test("a refused rate rejects and releases the mic", async () => {
    audio.restore();
    audio = installAudioMocks({ forceSampleRate: 48_000 });
    const stop = vi.fn();
    const nav = g.navigator as { mediaDevices: { getUserMedia: unknown } };
    nav.mediaDevices.getUserMedia = () => Promise.resolve({ getTracks: () => [{ stop }] });
    await expect(open()).rejects.toThrow(/sample rate/);
    await vi.waitFor(() => expect(stop).toHaveBeenCalled());
  });
});

describe("createVoiceIO({ preConnect })", () => {
  let audio: AudioMockContext & { restore: () => void };
  beforeEach(() => {
    audio = installAudioMocks();
  });
  afterEach(() => {
    audio.restore();
  });

  test("at the matching rate it ADOPTS the capture: no second mic, context or node", async () => {
    const gum = vi.spyOn(navigator.mediaDevices, "getUserMedia");
    const pre = await openPreConnectCapture({
      sampleRate: 16_000,
      captureWorkletSrc: "cap",
      maxSeconds: 10,
    });
    const node = findWorkletNode(audio.workletNodes(), "capture-processor");
    capture(node, chunk(4, 7));

    const sent: string[] = [];
    const io = await createVoiceIO(
      voiceOpts({
        sttSampleRate: 16_000,
        preConnect: pre,
        onPreConnectAudio: (c) => sent.push(`pre:${new Int16Array(c[0] as ArrayBuffer)[0]}`),
        onMicData: (b) => sent.push(`live:${new Int16Array(b)[0]}`),
      }),
    );
    capture(node, chunk(4, 8));

    expect(gum).toHaveBeenCalledOnce();
    expect(captureNodes(audio)).toHaveLength(1);
    expect(sent).toEqual(["pre:7", "live:8"]);
    await io.close();
    expect(node.ctx.closed).toBe(true);
  });

  test("with no onPreConnectAudio, the buffer goes to onMicData first", async () => {
    const pre = await openPreConnectCapture({
      sampleRate: 16_000,
      captureWorkletSrc: "cap",
      maxSeconds: 10,
    });
    const node = findWorkletNode(audio.workletNodes(), "capture-processor");
    capture(node, chunk(4, 1));
    capture(node, chunk(4, 2));
    const onMicData = vi.fn();
    const io = await createVoiceIO(
      voiceOpts({ sttSampleRate: 16_000, preConnect: pre, onMicData }),
    );
    expect(onMicData.mock.calls.map(([b]) => new Int16Array(b as ArrayBuffer)[0])).toEqual([1, 2]);
    await io.close();
  });

  test("at another rate it keeps the grant, retires the guess, and flushes the resampled buffer before live audio", async () => {
    const gum = vi.spyOn(navigator.mediaDevices, "getUserMedia");
    const pre = await openPreConnectCapture({
      sampleRate: 16_000,
      captureWorkletSrc: "cap",
      maxSeconds: 10,
    });
    const guessed = findWorkletNode(audio.workletNodes(), "capture-processor");
    capture(guessed, chunk(1600));

    const Offline = stubOfflineAudioContext();
    const order: string[] = [];
    const io = await createVoiceIO(
      voiceOpts({
        sttSampleRate: 24_000,
        preConnect: pre,
        onPreConnectAudio: (c) => order.push(`pre:${c.reduce((n, b) => n + b.byteLength / 2, 0)}`),
        onMicData: () => order.push("live"),
      }),
    );
    const live = captureNodes(audio).at(-1) as MockAudioWorkletNode;
    capture(live, chunk(4));

    expect(gum).toHaveBeenCalledOnce();
    expect(guessed.ctx.closed).toBe(true);
    expect(live.ctx.sampleRate).toBe(24_000);
    // 1600 samples at 16 kHz is 2400 at 24 kHz.
    expect(order).toEqual(["pre:2400", "live"]);
    await io.close();
    Offline.restore();
  });
});

describe("resamplePcm16", () => {
  test("is the identity at one rate", async () => {
    const chunks = [chunk(4)];
    expect(await resamplePcm16(chunks, 16_000, 16_000)).toBe(chunks);
  });

  test("drops the buffer, not the session, where offline rendering is missing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await resamplePcm16([chunk(4)], 16_000, 24_000)).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test("re-cuts the output at the live batch size", async () => {
    const Offline = stubOfflineAudioContext();
    // One second at 16 kHz → 24000 samples at 24 kHz → ten 0.1 s chunks.
    // Negative, because the encode scales by 0x8000 below zero and 0x7fff
    // above (as the capture worklet does), so only a negative round-trips.
    const out = await resamplePcm16([chunk(16_000, -0x40_00)], 16_000, 24_000);
    expect(out.map((b) => b.byteLength / 2)).toEqual(new Array(10).fill(2400));
    expect(new Int16Array(out[0] as ArrayBuffer)[0]).toBe(-0x40_00);
    Offline.restore();
  });
});

/**
 * A stand-in `OfflineAudioContext` whose render is a nearest-sample stretch —
 * enough to pin lengths, order and scaling; the band-limiting is the
 * browser's.
 */
function stubOfflineAudioContext(): { restore(): void } {
  const orig = g.OfflineAudioContext;
  type Buf = { sampleRate: number; data: Float32Array; getChannelData(): Float32Array };
  const makeBuf = (length: number, sampleRate: number): Buf => {
    const data = new Float32Array(length);
    return { sampleRate, data, getChannelData: () => data };
  };
  g.OfflineAudioContext = class {
    destination = {};
    private src: Buf | null = null;
    private readonly length: number;
    private readonly sampleRate: number;
    constructor(_channels: number, length: number, sampleRate: number) {
      this.length = length;
      this.sampleRate = sampleRate;
    }
    createBuffer(_c: number, length: number, rate: number) {
      return makeBuf(length, rate);
    }
    createBufferSource() {
      const node = {
        buffer: null as Buf | null,
        connect: () => undefined,
        start: () => {
          this.src = node.buffer;
        },
      };
      return node;
    }
    startRendering() {
      const out = makeBuf(this.length, this.sampleRate);
      const src = this.src;
      if (src) {
        for (let i = 0; i < this.length; i++) {
          out.data[i] =
            src.data[
              Math.min(src.data.length - 1, Math.floor((i * src.sampleRate) / this.sampleRate))
            ] ?? 0;
        }
      }
      return Promise.resolve(out);
    }
  };
  return {
    restore() {
      g.OfflineAudioContext = orig;
    },
  };
}
