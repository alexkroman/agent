// Copyright 2025 the AAI authors. MIT license.
import {
  CAPTURE_STOP_ACK_TIMEOUT_MS,
  PLAYBACK_DONE_MAX_WAIT_MS,
  PLAYBACK_DONE_POLL_MS,
  VOICE_CAPTURE_CONSTRAINTS,
} from "./types.ts";

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
  /**
   * Called every {@link PLAYBACK_PROGRESS_INTERVAL_MS} while the playback
   * buffer holds unplayed agent audio, with its depth in ms. Wire it to the
   * session's `playback_progress` frame: it is the host's only closed-loop
   * view of playback, and without it the host assumes every chunk it forwards
   * starts playing on arrival at exactly 1.0x — so a client whose buffer runs
   * ahead of the wall clock is told the line is silent while the caller is
   * still listening. Unwired, the host degrades to that estimate.
   */
  onPlaybackProgress?: ((bufferedMs: number) => void) | undefined;
  /**
   * Called once if the microphone delivers nothing but digital silence for
   * the first {@link MIC_SILENCE_PROBE_MS} of capture — a muted or wrong input
   * device, which otherwise looks exactly like a user who hasn't spoken.
   */
  onMicSilent?: (() => void) | undefined;
};

/**
 * Audio I/O interface for voice capture and playback.
 *
 * Manages microphone capture via an AudioWorklet and TTS audio playback
 * through a second AudioWorklet. Implements {@link AsyncDisposable} for
 * resource cleanup.
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
 * Throw unless the browser honored a requested context sample rate. The
 * requested rates are never advisory: captured audio is tagged with the
 * requested rate on the wire, so a context running at some other rate ships
 * audio that only sounds like speech to the wrong decoder. Every capture
 * path must call this after context creation.
 */
function assertGranted(granted: number, requested: number, side: string): void {
  if (granted === requested) return;
  throw new Error(
    `Browser refused the ${side} sample rate: asked for ${requested} Hz, got ${granted} Hz`,
  );
}

/**
 * The error a dead worklet processor reports.
 *
 * A processor exception permanently kills the node — no further messages or
 * audio will ever arrive — so both sides log it and hand it on. One spelling of
 * that, because the pair differed only in the word "capture"/"playback" and in
 * what the playback side has to settle afterwards.
 */
function workletCrash(side: "capture" | "playback"): Error {
  const err = new Error(`Audio ${side} worklet crashed`);
  console.error("[aai-ui]", err.message);
  return err;
}

/**
 * Release a microphone that was (or later gets) granted while another init
 * step failed; if `getUserMedia` itself rejected, this is a no-op. Without
 * it, a mic granted after a failed init keeps the browser's recording
 * indicator lit with no way to turn it off.
 */
function releaseStreamOnFailure(streamPromise: Promise<MediaStream>): void {
  void streamPromise
    .then((s) => {
      for (const t of s.getTracks()) t.stop();
    })
    .catch(() => {
      /* rejected with the same error */
    });
}

/** Handle to one capture worklet node (`worklets/capture-processor.ts`). */
export type CaptureNode = {
  node: AudioWorkletNode;
  /** Begin accumulating — the worklet gates capture on its start/stop protocol. */
  start(): void;
  /**
   * Stop accumulating and wait (bounded by {@link CAPTURE_STOP_ACK_TIMEOUT_MS})
   * for the 'stopped' ack that follows the worklet's final flush, so the tail
   * of speech reaches `onChunk` before the node is torn down.
   */
  stop(): Promise<void>;
};

/**
 * Wire one capture worklet node: node construction, the chunk/silent/stopped
 * port protocol, and the stop→ack handshake. No `processorOptions`: the
 * worklet reads the context rate from its global scope (callers assert the
 * granted rate first) and owns its own batching default — re-spelling
 * defaults caller-side is drift.
 */
function createCaptureNode(
  ctx: AudioContext,
  onChunk: (pcm16: ArrayBuffer) => void,
  onSilent?: () => void,
): CaptureNode {
  const node = new AudioWorkletNode(ctx, "capture-processor", {
    channelCount: 1,
    channelCountMode: "explicit",
  });
  let onStopped: (() => void) | null = null;
  node.port.onmessage = (e: MessageEvent) => {
    const d = e.data as { event?: string; buffer?: ArrayBuffer };
    if (d.event === "chunk" && d.buffer) {
      onChunk(d.buffer);
    } else if (d.event === "silent") {
      onSilent?.();
    } else if (d.event === "stopped") {
      onStopped?.();
      onStopped = null;
    }
  };
  return {
    node,
    start() {
      node.port.postMessage({ event: "start" });
    },
    stop() {
      // `Promise.withResolvers` rather than an executor: the resolver has to
      // outlive the constructor call — it is stored on `onStopped` for the port
      // handler above — so an executor only exists to hoist it back out.
      const { promise, resolve } = Promise.withResolvers<void>();
      const cap = setTimeout(resolve, CAPTURE_STOP_ACK_TIMEOUT_MS);
      onStopped = () => {
        clearTimeout(cap);
        resolve();
      };
      node.port.postMessage({ event: "stop" });
      return promise;
    },
  };
}

/**
 * Create a {@link VoiceIO} instance that captures microphone audio and
 * plays back TTS audio using the Web Audio API.
 *
 * Playback runs on a context at the TTS sample rate for fidelity, and capture
 * on its own context at the STT rate so the *browser* performs the rate
 * conversion with its band-limited resampler. The two collapse into one
 * context when the rates match. A browser that declines either requested rate
 * fails init rather than falling back to converting in the worklet, which
 * would alias.
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
    onPlaybackProgress,
    onMicSilent,
  } = opts;

  const ctx = new AudioContext({
    sampleRate: ttsSampleRate,
    latencyHint: "playback",
  });
  // One context can only run at one rate, so capture gets its own when it
  // needs a different one — the point being to let the browser resample the
  // mic stream, since its resampler is band-limited. `latencyHint:
  // "interactive"` because this side is barge-in sensitive, unlike playback.
  const sharesContext = sttSampleRate === ttsSampleRate;
  const capCtx = sharesContext
    ? ctx
    : new AudioContext({ sampleRate: sttSampleRate, latencyHint: "interactive" });

  // Release every context this call created, whether one or two.
  async function closeContexts(): Promise<void> {
    const contexts = sharesContext ? [ctx] : [ctx, capCtx];
    await Promise.all(
      contexts.map((c) =>
        c.close().catch((err: unknown) => {
          console.warn("AudioContext close failed:", err);
        }),
      ),
    );
  }

  // Mic permission, context resume, and worklet registration are independent —
  // run them concurrently so a slow permission prompt doesn't serialize setup.
  const streamPromise = navigator.mediaDevices.getUserMedia({
    audio: { deviceId: { ideal: "default" }, ...VOICE_CAPTURE_CONSTRAINTS },
  });

  // A single Promise.all so the first rejection (typically getUserMedia
  // permission denial) fails the whole init immediately instead of waiting
  // for the remaining steps to settle.
  let stream: MediaStream;
  try {
    [stream] = await Promise.all([
      streamPromise,
      ctx.resume(),
      capCtx.resume(),
      capCtx.audioWorklet.addModule(captureWorkletSrc),
      ctx.audioWorklet.addModule(playbackWorkletSrc),
    ]);
    // The requested rates are not advisory: capture audio is sent to a socket
    // that declared sttSampleRate, and playback writes PCM at ttsSampleRate
    // into the context verbatim, so a context running at some other rate
    // garbles one side or the other. Fail here rather than resample in the
    // worklet — that would alias — or stream audio that only sounds like
    // speech to the wrong decoder.
    assertGranted(capCtx.sampleRate, sttSampleRate, "capture");
    assertGranted(ctx.sampleRate, ttsSampleRate, "playback");
  } catch (err: unknown) {
    releaseStreamOnFailure(streamPromise);
    await closeContexts();
    throw err;
  }

  const mic = capCtx.createMediaStreamSource(stream);
  const capture = createCaptureNode(capCtx, onMicData, onMicSilent);
  mic.connect(capture.node);

  // No further mic chunks will ever arrive — surface it rather than staying
  // silently deaf.
  capture.node.onprocessorerror = () => onError?.(workletCrash("capture"));

  capture.start();

  let playNode: AudioWorkletNode | null = null;
  let onPlaybackStop: (() => void) | null = null;
  /**
   * Turn ids for the drain handshake. Every `done()` posts a fresh id and the
   * worklet echoes it on the matching 'stop', so a stop the worklet posted for
   * an EARLIER turn — already in flight when a barge-in flushed that turn —
   * cannot settle the current turn's wait. Dropping only `reason: 'interrupt'`
   * stops was not enough: the stale one is a legitimate drain stop, just for a
   * turn the host has already moved past, and settling on it reports the live
   * reply finished while it is still speaking.
   */
  let turnSeq = 0;
  let pendingStopTurn: number | null = null;
  const lifecycle = new AbortController();

  /** Settle whatever drain wait is pending and forget the turn it belonged to. */
  function settlePendingStop(): void {
    onPlaybackStop?.();
    onPlaybackStop = null;
    pendingStopTurn = null;
  }

  /** The playback worklet's turn-boundary report (see `stopTurn` there). */
  type WorkletStopMessage = {
    reason?: "done" | "interrupt";
    /** The turn id this turn's 'done' carried, echoed back. */
    turn?: number | null;
    stats?: PlaybackStats;
  };

  function onWorkletStop(msg: WorkletStopMessage): void {
    // Report before the drops below: concealment that happened before a
    // barge-in is real playback trouble, and dropping the stop must not drop
    // the measurement with it.
    if (msg.stats && msg.stats.concealedSamples > 0) onPlaybackStats?.(msg.stats);
    // An interrupt's stop belongs to a turn flush() already settled, so it is
    // dropped outright rather than counted against the next turn.
    if (msg.reason === "interrupt") return;
    // A drain stop for a turn the host is no longer waiting on — the flush
    // that ended that turn already settled its promise. Settling here would
    // report the CURRENT reply finished while it is still speaking.
    if (pendingStopTurn !== null && msg.turn !== pendingStopTurn) return;
    settlePendingStop();
  }

  // One persistent node per session: the worklet's 60s Float32 buffer is
  // multi-MB, so tearing it down per reply would pay a fresh allocation and
  // worklet instantiation on every conversational turn. The processor resets
  // its own per-turn state after each 'stop'.
  function ensurePlayNode(): AudioWorkletNode {
    if (playNode) return playNode;
    // No processorOptions: the worklet reads the context rate from its
    // global scope, and this node's context is the (rate-asserted) playback
    // context.
    const node = new AudioWorkletNode(ctx, "playback-processor");
    node.connect(ctx.destination);
    node.port.onmessage = (e: MessageEvent) => {
      if (e.data.event === "stop") onWorkletStop(e.data as WorkletStopMessage);
      else if (e.data.event === "progress") onPlaybackProgress?.(e.data.bufferedMs as number);
    };
    // A dead processor never posts 'stop' — settle any pending done() wait so
    // session state can't hang in "speaking", then surface the failure.
    node.onprocessorerror = () => {
      const err = workletCrash("playback");
      settlePendingStop();
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
      // The turn is over — always tell the worklet, whether or not we wait:
      // without the 'done' the buffered reply strands (isDone stays false),
      // and on resume the processor conceals forever after the drain, with
      // its per-turn state and stats bleeding into the next reply.
      const turn = ++turnSeq;
      playNode.port.postMessage({ event: "done", turn });
      // The worklet reports completion from process(), which only runs while
      // the context is rendering. If it's suspended/closed (e.g. a backgrounded
      // tab), the 'stop' round-trip never happens — resolve now rather than hang.
      if (ctx.state !== "running") {
        pendingStopTurn = null;
        return Promise.resolve();
      }
      // `Promise.withResolvers` for the same reason `stop()` above uses it: the
      // resolver is stored on `onPlaybackStop` for the port handler to call, so
      // it has to outlive the constructor rather than be hoisted out of one.
      const { promise, resolve } = Promise.withResolvers<void>();
      // Settle a resolver this call replaces so its promise never strands.
      onPlaybackStop?.();
      // Bounded wait: if the context suspends mid-playback or the processor
      // dies, the 'stop' message never arrives — resolve anyway so session
      // state can't be stuck in "speaking". The poll catches a suspension
      // quickly; the hard cap covers a silently dead processor and sits
      // just past the worklet's PLAYBACK_BUFFER_SECONDS ring (the longest
      // legitimate drain).
      const settle = (): void => {
        clearInterval(poll);
        clearTimeout(cap);
        if (onPlaybackStop === settle) {
          onPlaybackStop = null;
          pendingStopTurn = null;
        }
        resolve();
      };
      const poll = setInterval(() => {
        if (ctx.state !== "running") settle();
      }, PLAYBACK_DONE_POLL_MS);
      const cap = setTimeout(settle, PLAYBACK_DONE_MAX_WAIT_MS);
      onPlaybackStop = settle;
      pendingStopTurn = turn;
      return promise;
    },

    flush() {
      if (!playNode) return;
      // The interrupted turn is over: settle its pending done() now. The stop
      // the worklet posts for this interrupt carries reason 'interrupt' and is
      // dropped by the port handler above; a DRAIN stop for the same turn that
      // was already in flight is dropped by the turn-id check there.
      settlePendingStop();
      playNode.port.postMessage({ event: "interrupt" });
    },

    async close() {
      if (lifecycle.signal.aborted) return;
      lifecycle.abort();
      // Bounded stop→ack wait, so the tail of speech reaches onMicData
      // before the port is torn down with the context — otherwise the last
      // ~100ms of an utterance is dropped.
      await capture.stop();
      mic.disconnect();
      capture.node.disconnect();
      if (playNode) playNode.disconnect();
      for (const t of stream.getTracks()) t.stop();
      await closeContexts();
    },

    async [Symbol.asyncDispose]() {
      await io.close();
    },
  };
  return io;
}
