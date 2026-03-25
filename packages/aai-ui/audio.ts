// Copyright 2025 the AAI authors. MIT license.
import { MIC_BUFFER_SECONDS } from "./types.ts";

/** Configuration for creating a {@link VoiceIO} instance. */
export type VoiceIOOptions = {
  /** Sample rate in Hz expected by the STT engine (e.g. 16000). */
  sttSampleRate: number;
  /** Sample rate in Hz used by the TTS engine (e.g. 22050). */
  ttsSampleRate: number;
  /** Source URL or data URI for the capture AudioWorklet processor. */
  captureWorkletSrc: string;
  /** Source URL or data URI for the playback AudioWorklet processor. */
  playbackWorkletSrc: string;
  /** Callback invoked with buffered PCM16 microphone data to send to the server. */
  onMicData: (pcm16: ArrayBuffer) => void;
  /** Callback invoked with the current playback position in samples. */
  onPlaybackProgress?: (samplesPlayed: number) => void;
};

/**
 * Audio I/O interface for voice capture and playback.
 *
 * Manages microphone capture via an AudioWorklet, resampling to the STT
 * sample rate, and TTS audio playback through a second AudioWorklet. Implements
 * {@link AsyncDisposable} for resource cleanup.
 */
export type VoiceIO = AsyncDisposable & {
  /** Enqueue a PCM16 audio buffer for playback through the TTS pipeline. */
  enqueue(pcm16Buffer: ArrayBuffer): void;
  /** Signal that all TTS audio for the current turn has been enqueued.
   *  Resolves when the worklet has finished playing all buffered audio. */
  done(): Promise<void>;
  /** Immediately stop playback and discard any buffered TTS audio. */
  flush(): void;
  /** Release all audio resources (microphone, AudioContext, worklets). */
  close(): Promise<void>;
};

/**
 * Create a {@link VoiceIO} instance that captures microphone audio and
 * plays back TTS audio using the Web Audio API.
 *
 * The AudioContext runs at the TTS sample rate for playback fidelity.
 * Captured audio is resampled to the STT rate when the rates differ.
 *
 * @param opts - Voice I/O configuration options.
 * @returns A promise that resolves to a {@link VoiceIO} handle.
 * @throws If microphone access is denied or AudioWorklet registration fails.
 */
export async function createVoiceIO(opts: VoiceIOOptions): Promise<VoiceIO> {
  const { sttSampleRate, ttsSampleRate, captureWorkletSrc, playbackWorkletSrc, onMicData } = opts;

  // Use TTS rate for the context — playback fidelity is more perceptible.
  // Capture path resamples to STT rate if they differ.
  const contextRate = ttsSampleRate;
  const ctx = new AudioContext({
    sampleRate: contextRate,
    latencyHint: "playback",
  });
  await ctx.resume();

  // Single AudioContext owns both capture and playback — required for AEC.
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      sampleRate: contextRate,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  try {
    await Promise.all([
      ctx.audioWorklet.addModule(captureWorkletSrc),
      ctx.audioWorklet.addModule(playbackWorkletSrc),
    ]);
  } catch (err: unknown) {
    for (const t of stream.getTracks()) t.stop();
    await ctx.close().catch(() => {
      /* swallow */
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

  // Worklet outputs PCM16 at the STT rate — just batch and send.
  const chunkSizeBytes = Math.floor(sttSampleRate * MIC_BUFFER_SECONDS) * 2;
  const capBuf = new Uint8Array(chunkSizeBytes * 2);
  let capOffset = 0;

  capNode.port.postMessage({ event: "start" });

  capNode.port.onmessage = (e: MessageEvent) => {
    if (e.data.event !== "chunk") return;
    const chunk = new Uint8Array(e.data.buffer as ArrayBuffer);

    capBuf.set(chunk, capOffset);
    capOffset += chunk.byteLength;

    if (capOffset >= chunkSizeBytes) {
      onMicData(capBuf.slice(0, capOffset).buffer);
      capOffset = 0;
    }
  };

  let playNode: AudioWorkletNode | null = null;
  let onPlaybackStop: (() => void) | null = null;
  const lifecycle = new AbortController();
  const { onPlaybackProgress } = opts;

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
