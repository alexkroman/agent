// Copyright 2025 the AAI authors. MIT license.
/**
 * The OPENER CONTRACT — what a speech stage of the host's own is written
 * against, and what `registerSttKind` / `registerTtsKind` take.
 *
 * Declared HERE, in the host runtime, rather than beside the descriptors in
 * `@alexkroman1/aai`'s `sdk/providers.ts`. The descriptor layer
 * (`SttProvider` / `TtsProvider`) is pure data an agent author holds; the
 * openable layer is host-only — it talks to the network, and only this package
 * resolves a descriptor into one. It used to be declared in the SDK and cross
 * on `@alexkroman1/aai/host-internal`, which put the declarations in a package
 * whose contracts deny-list that subpath: the `providers` capability here then
 * named every opener type while hashing none of them, so a signature change on
 * `SttSession` moved no epoch anywhere. Nothing in the SDK uses them (its only
 * mentions are doc comments), so the declarations came to the one package that
 * does, and the capability that publishes them now owns them.
 *
 * Published from the root barrel as the `providers` capability; the in-package
 * openers import them from here by relative path.
 */

/** Unsubscribe callback returned by `.on()` event subscriptions. */
export type Unsubscribe = () => void;

// -------- STT openable (host-only) ------------------------------------------

/**
 * Error raised by an STT provider stream, with a typed `code` naming the
 * failure phase: connecting, authenticating, or mid-stream.
 */
export interface SttError extends Error {
  readonly code: "stt_connect_failed" | "stt_auth_failed" | "stt_stream_error";
}

/** Build an {@link SttError} with a typed `code`. Zero-dep helper so both sdk/ and host/ can use it. */
export function createSttError(code: SttError["code"], message: string): SttError {
  return Object.assign(new Error(message), { code }) as SttError;
}

/** Events emitted by an open {@link SttSession}. */
/**
 * Provider-reported detail about the turn a transcript belongs to.
 *
 * Optional throughout: every field is something a given provider may not
 * report, and a consumer must treat `undefined` as "no opinion" rather than
 * as a low value. Passed alongside the text rather than folded into it so
 * that a provider gaining a signal does not change any existing call site.
 */
export type SttTurnMeta = {
  /**
   * The service's confidence that the user's turn has ENDED, 0..1, as of this
   * transcript. AssemblyAI reports it per interim turn
   * (`end_of_turn_confidence`); providers that do not report it omit it.
   *
   * It rises as an utterance settles and resets when the caller resumes, so a
   * dictated identifier produces a sawtooth rather than a ramp — observed on
   * a spoken phone number: `0, 0.25, 0` across revisions of the same prefix,
   * then `0 → 0.25 → 0.4 → 0.55 → 0.7 → 0.8 → 0.95 → 1` once the full number
   * had landed. That shape is why it is worth having: the silence-window
   * knobs (`min_turn_silence`) decide end-of-turn on elapsed time alone and
   * cannot tell "paused between digits" from "finished", which is the
   * mechanism that truncates a spelled identifier mid-entity.
   *
   * One policy reads it today: PREEMPTIVE GENERATION
   * (`AgentDef.preemptiveGeneration`, OFF by default), which starts a
   * speculative LLM stream from an interim whose confidence clears
   * `PREEMPTIVE_CONFIDENCE_THRESHOLD`. The sawtooth above is not
   * background for that policy — it DICTATED two of its rules, and both are
   * only defensible while the trace stays here. (1) A partial whose normalized
   * text differs from the live speculation's prompt aborts it immediately, so a
   * false peak partway through a dictated identifier dies on the next digit
   * instead of being billed in full. (2) An identical text at rising confidence
   * never re-fires, which is what the terminal `0.95 → 1` re-emission above
   * would otherwise cost on every completed utterance. Endpointing itself is
   * still time-based and unchanged; a confidence-aware endpointing or barge-in
   * policy remains unbuilt, and this field is still what would let one be
   * measured against the current one rather than guessed at.
   */
  endOfTurnConfidence?: number;
  /**
   * The loudest inbound audio under this transcript's words, in dBFS: RMS
   * over 50 ms blocks of the PCM16 the provider actually sent, across the
   * words' span on the service's own audio clock (padded 100 ms either side).
   * Omitted when the provider reports no word timings, or the span falls
   * outside the audio it still has a level for.
   *
   * Read against the caller's own speech level, not as an absolute: a
   * transcript far quieter than the caller's committed turns is audio the
   * caller did not speak into the microphone (a television, a conversation
   * across the room), and the pipeline transport will not let it interrupt a
   * reply. A custom provider may report it on the same terms or omit it; an
   * omitted level never blocks anything.
   */
  inputPeakDbfs?: number;
};

export type SttEvents = {
  /** Interim transcript; drives barge-in detection. */
  partial: (text: string, meta?: SttTurnMeta) => void;
  /** End-of-turn final transcript; cue to run the LLM. */
  final: (text: string, meta?: SttTurnMeta) => void;
  /** Terminal error. The session is expected to end after this fires. */
  error: (err: SttError) => void;
};

/**
 * Host-side handle to one open STT provider stream (pipeline mode). Produced
 * by the host's provider resolver at session start; user code never
 * constructs one.
 */
export interface SttSession {
  /** Push one PCM16 audio frame from the client into the transcriber. */
  sendAudio(pcm: Int16Array): void;
  on<E extends keyof SttEvents>(event: E, fn: SttEvents[E]): Unsubscribe;
  close(): Promise<void>;
  /**
   * Move the end-of-turn silence window mid-stream, in ms — what the
   * regex-keyed endpointing rule table is applied THROUGH.
   *
   * The window is the STT's decision, not the transport's (a host-side hold on
   * a committed final could only ever lengthen the wait, and would lengthen it
   * AFTER the provider had already split the utterance), so a provider that
   * cannot be re-configured mid-stream cannot honour the table at all.
   *
   * Optional for exactly that reason: a provider with no equivalent omits it,
   * callers use `?.()`, and the transport says once that the rules are inert.
   * Today only AssemblyAI has it (`UpdateConfiguration.min_turn_silence`).
   */
  updateEndpointing?(minTurnSilenceMs: number): void;
  /**
   * End the current turn NOW, as a pause would have — what `userTurnLimit` is
   * applied THROUGH.
   *
   * The provider answers with the ordinary `final` for the words it has heard
   * so far, so the transport commits the turn on the same path every other
   * turn takes, and speech after the cut opens the provider's next turn. A
   * host-side cut could do neither: it would have to commit an interim and
   * then reconcile it against a final the provider still owes for the same
   * utterance.
   *
   * Optional for the reason {@link updateEndpointing} is: a provider with no
   * equivalent omits it, callers use `?.()`, and the transport says once that
   * the cap is inert. Today only AssemblyAI has it (`ForceEndpoint`).
   */
  forceEndOfTurn?(): void;
}

/** Options the host passes when opening an STT stream. */
export interface SttOpenOptions {
  /** Capture sample rate of the inbound PCM, in Hz. */
  sampleRate: number;
  /** Provider API key, resolved from the agent's env. */
  apiKey: string;
  sttPrompt?: string | undefined;
  signal: AbortSignal;
}

/**
 * Host-side openable STT provider — produced by `resolveStt(descriptor)`.
 * Part of the host-only opener layer, never constructed by an AGENT.
 *
 * Not `@internal`: it is the parameter of `registerSttKind` on
 * `@alexkroman1/aai-runtime`, which is how a HOST application substitutes a
 * fake speech stage (the behaviour eval tier's level-1 target does exactly
 * that). It is deliberately absent from `@alexkroman1/aai/stt`, where the rest
 * of the opener-layer types live — an agent author picks a descriptor and never
 * writes one of these.
 */
export interface SttOpener {
  readonly name: string;
  open(options: SttOpenOptions): Promise<SttSession>;
}

// -------- TTS openable (host-only) ------------------------------------------

/**
 * Error raised by a TTS provider stream, with a typed `code` naming the
 * failure phase: connecting, authenticating, or mid-stream.
 */
export interface TtsError extends Error {
  readonly code: "tts_connect_failed" | "tts_auth_failed" | "tts_stream_error";
}

/** Build a {@link TtsError} with a typed `code`. Mirror of {@link createSttError}. */
export function createTtsError(code: TtsError["code"], message: string): TtsError {
  return Object.assign(new Error(message), { code }) as TtsError;
}

/**
 * One synthesized word and where its audio sits in the current turn.
 *
 * Offsets are milliseconds into THIS TURN's synthesized audio (the first
 * sample the provider produced for the turn is 0), not into the session, so
 * they line up with the transport's per-reply audio accounting. Providers that
 * report per-socket or per-flush clocks are rebased by their own adapter before
 * the event is emitted.
 */
export interface TtsWordTiming {
  /** The word as the provider synthesized it (may be normalized: "$5.00" → "five dollars"). */
  readonly text: string;
  /** Start offset of the word's audio, ms into the turn. */
  readonly startMs: number;
  /** End offset of the word's audio, ms into the turn. */
  readonly endMs: number;
}

/** Events emitted by an open {@link TtsSession}. */
export type TtsEvents = {
  /** One PCM16 audio chunk. Orchestrator forwards to the client. */
  audio: (pcm: Int16Array) => void;
  /**
   * Word timings for audio this turn has produced, when the provider reports
   * them. Required in the type but OPTIONAL in practice: every adapter builds
   * a `createNanoEvents<TtsEvents>()` emitter, so a provider with no timings
   * simply never emits it, and a consumer must treat their absence as the
   * ordinary case (the pipeline transport falls back to a proportional
   * estimate). Whether a given reply has timings is a RUNTIME fact — a
   * provider may report them for some segments and not others — so there is no
   * capability flag to check.
   *
   * **Carries no turn id**, exactly like {@link TtsEvents.done}: the transport
   * cannot filter a stale one itself and gates the event on its own turn state
   * (the audio gate in `pipeline-transport.ts`). An adapter must not emit
   * timings for a cancelled turn.
   */
  words: (words: readonly TtsWordTiming[]) => void;
  /**
   * Synthesis drained after flush() or cancel(). Emitted exactly once per
   * turn, and never after `cancel()` for the cancelled turn: `cancel()` must
   * clear any pending done timers/frames so a stale `done` cannot leak into
   * the next turn's flush-wait (the event carries no turn id, so the
   * pipeline transport cannot filter it — see pipeline-transport.ts).
   */
  done: () => void;
  /** Terminal error. The session is expected to end after this fires. */
  error: (err: TtsError) => void;
};

/**
 * Host-side handle to one open TTS provider stream (pipeline mode). Produced
 * by the host's provider resolver at session start; user code never
 * constructs one.
 */
export interface TtsSession {
  /** Push text deltas from the LLM. Provider may synthesize as chunks arrive. */
  sendText(text: string): void;
  /** Signal "no more text this turn". Emits `done` when fully synthesized. */
  flush(): void;
  /** Interrupt immediately (barge-in). Emits `done` synchronously. */
  cancel(): void;
  on<E extends keyof TtsEvents>(event: E, fn: TtsEvents[E]): Unsubscribe;
  close(): Promise<void>;
}

/** Options the host passes when opening a TTS stream. */
export interface TtsOpenOptions {
  /** Playback sample rate of the synthesized PCM, in Hz. */
  sampleRate: number;
  /** Provider API key, resolved from the agent's env. */
  apiKey: string;
  /** Aborts the open (and the session) when the voice session ends. */
  signal: AbortSignal;
}

/**
 * Host-side openable TTS provider — produced by `resolveTts(descriptor)`.
 * Part of the host-only opener layer, never constructed by an AGENT. See
 * {@link SttOpener} for why it carries no `@internal` tag.
 */
export interface TtsOpener {
  readonly name: string;
  open(options: TtsOpenOptions): Promise<TtsSession>;
}
