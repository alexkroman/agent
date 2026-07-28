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

  // Mic permission, context resume, and worklet registration are independent —
  // run them concurrently so a slow permission prompt doesn't serialize setup.
  const streamPromise = navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: { ideal: "default" },
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      voiceIsolation: true,
    } as MediaTrackConstraints,
  });

  // A single Promise.all so the first rejection (typically getUserMedia
  // permission denial) fails the whole init immediately instead of waiting
  // for the remaining steps to settle.
  let stream: MediaStream;
  try {
    [stream] = await Promise.all([
      streamPromise,
      ctx.resume(),
      ctx.audioWorklet.addModule(captureWorkletSrc),
      ctx.audioWorklet.addModule(playbackWorkletSrc),
    ]);
  } catch (err: unknown) {
    // If the mic was (or later gets) granted while another step failed,
    // release it; if getUserMedia itself rejected, the catch is a no-op.
    void streamPromise
      .then((s) => {
        for (const t of s.getTracks()) t.stop();
      })
      .catch(() => {
        /* rejected with the same error */
      });
    await ctx.close().catch((err) => {
      console.warn("AudioContext close failed:", err);
    });
    throw err;
  }

  const mic = ctx.createMediaStreamSource(stream);
  const capNode = new AudioWorkletNode(ctx, "capture-processor", {
    channelCount: 1,
    channelCountMode: "explicit",
    processorOptions: { contextRate, sttSampleRate, bufferSeconds: MIC_BUFFER_SECONDS },
  });
  mic.connect(capNode);

  capNode.port.postMessage({ event: "start" });

  // The worklet batches ~MIC_BUFFER_SECONDS of PCM16 at the STT rate and posts
  // one transferred ArrayBuffer per flush — just forward it.
  capNode.port.onmessage = (e: MessageEvent) => {
    if (e.data.event !== "chunk") return;
    onMicData(e.data.buffer as ArrayBuffer);
  };

  let playNode: AudioWorkletNode | null = null;
  let onPlaybackStop: (() => void) | null = null;
  const lifecycle = new AbortController();

  // One persistent node per session: the worklet's 60s Float32 buffer is
  // multi-MB, so tearing it down per reply would pay a fresh allocation and
  // worklet instantiation on every conversational turn. The processor resets
  // its own per-turn state after each 'stop'.
  function ensurePlayNode(): AudioWorkletNode {
    if (playNode) return playNode;
    const node = new AudioWorkletNode(ctx, "playback-processor", {
      processorOptions: { sampleRate: contextRate },
    });
    node.connect(ctx.destination);
    node.port.onmessage = (e: MessageEvent) => {
      if (e.data.event === "stop") {
        onPlaybackStop?.();
        onPlaybackStop = null;
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
      // The worklet reports completion from process(), which only runs while
      // the context is rendering. If it's suspended/closed (e.g. a backgrounded
      // tab), the 'stop' round-trip never happens — resolve now rather than hang.
      if (ctx.state !== "running") return Promise.resolve();
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
