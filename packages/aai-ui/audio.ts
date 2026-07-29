// Copyright 2025 the AAI authors. MIT license.
import { MIC_BUFFER_SECONDS } from "./types.ts";

/** How often {@link VoiceIO.done} checks that the AudioContext is still rendering. */
const DONE_POLL_INTERVAL_MS = 1000;

/**
 * Hard cap on waiting for playback to drain. The playback worklet buffers up
 * to 60s of audio, so the longest legitimate drain is just under that — a
 * wait past this means the processor died without reporting 'stop'.
 */
const DONE_MAX_WAIT_MS = 65_000;

/**
 * Bounded wait for the capture worklet's 'stopped' ack during close(). The
 * ack follows the final flush, so waiting for it keeps the tail of speech
 * from being dropped; the timeout covers a dead worklet.
 */
const CAPTURE_STOP_ACK_TIMEOUT_MS = 250;

/**
 * Decode an audio file (any container/codec the browser can decode) and
 * resample it to mono PCM16 at `targetRate` — the format the server's STT
 * side expects on the wire. Returns the raw clip; any endpointing padding
 * is the caller's concern (the one-shot upload path needs none).
 *
 * @throws If the browser cannot decode the payload.
 */
export async function decodeAudioToPcm16(
  data: ArrayBuffer,
  targetRate: number,
): Promise<Int16Array> {
  // Decode on a throwaway 1-frame offline context: decodeAudioData lives on
  // BaseAudioContext, and an offline context needs no audio-hardware handle
  // (browsers cap concurrent realtime AudioContexts).
  const decoded = await new OfflineAudioContext(1, 1, targetRate).decodeAudioData(data);
  const frames = Math.ceil(decoded.duration * targetRate);
  const offline = new OfflineAudioContext(1, frames, targetRate);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  const f32 = rendered.getChannelData(0);
  const pcm = new Int16Array(f32.length);
  // for-of over the typed array: every sample is in bounds, so this avoids
  // a per-sample undefined check that indexed access would require.
  let i = 0;
  for (const sample of f32) {
    const s = Math.max(-1, Math.min(1, sample));
    pcm[i++] = s < 0 ? s * 0x80_00 : s * 0x7f_ff;
  }
  return pcm;
}

/**
 * How much of one turn's playback was covered by concealment rather than
 * received audio — the playback worklet's underrun report, in the shape
 * WebRTC's `inbound-rtp` audio stats use, so the numbers mean the same thing
 * here as in a `getStats()` dump.
 *
 * A turn with `concealmentEvents: 0` never needed its jitter buffer; a turn
 * with a high `silentConcealedSamples` share starved for longer than
 * concealment can plausibly cover, which is a bandwidth problem rather than a
 * buffer-tuning one.
 *
 * @public
 */
export type PlaybackStats = {
  /** Samples emitted to cover a gap, including the silent ones. */
  concealedSamples: number;
  /** The subset of {@link PlaybackStats.concealedSamples} that were silence. */
  silentConcealedSamples: number;
  /** Distinct underrun episodes, however many render quanta each spanned. */
  concealmentEvents: number;
  /** Episodes that lasted long enough to decay to silence. */
  silentConcealmentEvents: number;
};

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
  /**
   * Called when an AudioWorklet processor throws and is killed by the browser
   * (the node produces no further audio or messages), so the session can
   * transition out of listening/speaking instead of looking healthy forever.
   */
  onError?: ((err: Error) => void) | undefined;
  /**
   * Called at the end of any turn whose playback had to conceal a gap. Never
   * called for a clean turn, so it can be wired straight to a warning.
   */
  onPlaybackStats?: ((stats: PlaybackStats) => void) | undefined;
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
  const {
    sttSampleRate,
    ttsSampleRate,
    captureWorkletSrc,
    playbackWorkletSrc,
    onMicData,
    onError,
    onPlaybackStats,
  } = opts;

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

  // A processor exception permanently kills the worklet — no further mic
  // chunks will ever arrive. Surface it rather than staying silently deaf.
  capNode.onprocessorerror = () => {
    const err = new Error("Audio capture worklet crashed");
    console.error("[aai-ui]", err.message);
    onError?.(err);
  };

  capNode.port.postMessage({ event: "start" });

  let onCaptureStopped: (() => void) | null = null;

  // The worklet batches ~MIC_BUFFER_SECONDS of PCM16 at the STT rate and posts
  // one transferred ArrayBuffer per flush — just forward it. 'stopped' acks
  // the final flush during close().
  capNode.port.onmessage = (e: MessageEvent) => {
    if (e.data.event === "chunk") {
      onMicData(e.data.buffer as ArrayBuffer);
    } else if (e.data.event === "stopped") {
      onCaptureStopped?.();
      onCaptureStopped = null;
    }
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
        // Report before the interrupt-drop below: concealment that happened
        // before a barge-in is real playback trouble, and dropping the stop
        // must not drop the measurement with it.
        const stats = e.data.stats as PlaybackStats | undefined;
        if (stats && stats.concealedSamples > 0) onPlaybackStats?.(stats);
        // An interrupt's stop belongs to a turn flush() already settled —
        // dropping it here (rather than flagging "the next stop is stale")
        // means it can never swallow a real drain-stop that was already in
        // flight when the flush happened, nor settle a later turn early.
        if (e.data.reason === "interrupt") return;
        onPlaybackStop?.();
        onPlaybackStop = null;
      }
    };
    // A dead processor never posts 'stop' — settle any pending done() wait so
    // session state can't hang in "speaking", then surface the failure.
    node.onprocessorerror = () => {
      const err = new Error("Audio playback worklet crashed");
      console.error("[aai-ui]", err.message);
      onPlaybackStop?.();
      onPlaybackStop = null;
      onError?.(err);
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
        // Settle a resolver this call replaces so its promise never strands.
        onPlaybackStop?.();
        // Bounded wait: if the context suspends mid-playback or the processor
        // dies, the 'stop' message never arrives — resolve anyway so session
        // state can't be stuck in "speaking". The poll catches a suspension
        // quickly; the hard cap covers a silently dead processor and sits
        // just past the worklet's 60s buffer (the longest legitimate drain).
        const settle = (): void => {
          clearInterval(poll);
          clearTimeout(cap);
          if (onPlaybackStop === settle) onPlaybackStop = null;
          resolve();
        };
        const poll = setInterval(() => {
          if (ctx.state !== "running") settle();
        }, DONE_POLL_INTERVAL_MS);
        const cap = setTimeout(settle, DONE_MAX_WAIT_MS);
        onPlaybackStop = settle;
        playNode?.port.postMessage({ event: "done" });
      });
    },

    flush() {
      if (!playNode) return;
      // The interrupted turn is over: settle its pending done() now. The
      // stop the worklet posts for this interrupt carries reason
      // 'interrupt' and is dropped by the port handler above.
      onPlaybackStop?.();
      onPlaybackStop = null;
      playNode.port.postMessage({ event: "interrupt" });
    },

    async close() {
      if (lifecycle.signal.aborted) return;
      lifecycle.abort();
      // Wait (bounded) for the worklet to ack the final flush, so the tail
      // of speech reaches onMicData before the port is torn down with the
      // context — otherwise the last ~100ms of an utterance is dropped.
      await new Promise<void>((resolve) => {
        const cap = setTimeout(resolve, CAPTURE_STOP_ACK_TIMEOUT_MS);
        onCaptureStopped = () => {
          clearTimeout(cap);
          resolve();
        };
        capNode.port.postMessage({ event: "stop" });
      });
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
