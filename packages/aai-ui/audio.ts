// Copyright 2025 the AAI authors. MIT license.
import { MIC_BUFFER_SECONDS } from "./types.ts";

export type VoiceIOOptions = {
  sttSampleRate: number;
  ttsSampleRate: number;
  captureWorkletSrc: string;
  playbackWorkletSrc: string;
  onMicData: (pcm16: ArrayBuffer) => void;
  onPlaybackProgress?: (samplesPlayed: number) => void;
};

export type VoiceIO = AsyncDisposable & {
  enqueue(pcm16Buffer: ArrayBuffer): void;
  done(): Promise<void>;
  flush(): void;
  close(): Promise<void>;
};

export async function createVoiceIO(opts: VoiceIOOptions): Promise<VoiceIO> {
  const {
    sttSampleRate,
    ttsSampleRate,
    captureWorkletSrc,
    playbackWorkletSrc,
    onMicData,
    onPlaybackProgress,
  } = opts;

  // AudioContext runs at TTS rate for playback fidelity; capture path resamples to STT rate.
  const contextRate = ttsSampleRate;
  const ctx = new AudioContext({
    sampleRate: contextRate,
    latencyHint: "playback",
  });
  await ctx.resume();

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: { ideal: "default" },
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      voiceIsolation: true,
    } as MediaTrackConstraints,
  });

  try {
    await Promise.all([
      ctx.audioWorklet.addModule(captureWorkletSrc),
      ctx.audioWorklet.addModule(playbackWorkletSrc),
    ]);
  } catch (err: unknown) {
    for (const t of stream.getTracks()) t.stop();
    await ctx.close().catch((err) => {
      console.warn("AudioContext close failed:", err);
    });
    throw err;
  }

  const mic = ctx.createMediaStreamSource(stream);
  const capNode = new AudioWorkletNode(ctx, "capture-processor", {
    channelCount: 1,
    channelCountMode: "explicit",
    processorOptions: { contextRate, sttSampleRate },
  });
  mic.connect(capNode);

  const chunkSizeBytes = Math.floor(sttSampleRate * MIC_BUFFER_SECONDS) * 2;
  const bufSize = chunkSizeBytes * 2;
  const capBufA = new Uint8Array(bufSize);
  const capBufB = new Uint8Array(bufSize);
  let capBuf = capBufA;
  let capOffset = 0;

  capNode.port.postMessage({ event: "start" });

  capNode.port.onmessage = (e: MessageEvent) => {
    if (e.data.event !== "chunk") return;
    const chunk = new Uint8Array(e.data.buffer as ArrayBufferLike);

    capBuf.set(chunk, capOffset);
    capOffset += chunk.byteLength;

    if (capOffset >= chunkSizeBytes) {
      onMicData(capBuf.buffer.slice(0, capOffset));
      // Swap to the other pre-allocated buffer to avoid GC pressure.
      capBuf = capBuf === capBufA ? capBufB : capBufA;
      capOffset = 0;
    }
  };

  let playNode: AudioWorkletNode | null = null;
  let onPlaybackStop: (() => void) | null = null;
  const lifecycle = new AbortController();

  function ensurePlayNode(): AudioWorkletNode {
    if (playNode) return playNode;
    const node = new AudioWorkletNode(ctx, "playback-processor", {
      processorOptions: { sampleRate: contextRate },
    });
    node.connect(ctx.destination);
    node.port.onmessage = (e: MessageEvent) => {
      if (e.data.event === "stop") {
        node.disconnect();
        if (playNode === node) playNode = null;
        onPlaybackStop?.();
        onPlaybackStop = null;
      } else if (e.data.event === "progress") {
        onPlaybackProgress?.(e.data.readPos);
      }
    };
    playNode = node;
    return node;
  }

  const io: VoiceIO = {
    enqueue(pcm16Buffer: ArrayBuffer) {
      if (lifecycle.signal.aborted) return;
      if (pcm16Buffer.byteLength === 0) return;
      const node = ensurePlayNode();
      node.port.postMessage({ event: "write", buffer: new Uint8Array(pcm16Buffer) }, [pcm16Buffer]);
    },

    done() {
      if (!playNode) return Promise.resolve();
      return new Promise<void>((resolve) => {
        onPlaybackStop = resolve;
        playNode?.port.postMessage({ event: "done" });
      });
    },

    flush() {
      if (playNode) playNode.port.postMessage({ event: "interrupt" });
    },

    async close() {
      if (lifecycle.signal.aborted) return;
      lifecycle.abort();
      capNode.port.postMessage({ event: "stop" });
      mic.disconnect();
      capNode.disconnect();
      if (playNode) playNode.disconnect();
      for (const t of stream.getTracks()) t.stop();
      await ctx.close().catch(() => {
        /* swallow */
      });
    },

    async [Symbol.asyncDispose]() {
      await io.close();
    },
  };
  return io;
}
