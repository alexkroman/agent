// Copyright 2025 the AAI authors. MIT license.
/**
 * Pluggable provider contracts.
 *
 * **Two layers, strict boundary.**
 *
 * - The *descriptor* layer (`SttProvider` / `LlmProvider` / `TtsProvider`) is
 *   pure data — `{ kind, options }` objects returned by the user-facing
 *   factories (`assemblyAIStt(...)`, `anthropicLlm(...)`, `cartesiaTts(...)`). They
 *   are JSON-serializable, contain no functions, and can cross the CLI →
 *   server → guest boundary without evaluating any third-party SDK.
 *   They live in `sdk/` alongside `Manifest` and have zero Node-only deps.
 *
 * - The *openable* layer (`SttOpener` / `TtsOpener` + `SttSession` /
 *   `TtsSession`) is host-only. The host's internal
 *   `host/providers/resolve.ts` registry turns descriptors into openers
 *   during `createRuntime`, importing the concrete SDKs (`assemblyai`,
 *   `@cartesia/cartesia-js`, `@ai-sdk/anthropic`) only at that point.
 *   Only the openable layer talks to the network; descriptors never do.
 *
 * This split is load-bearing for the sandboxed deployment path: the guest
 * sandbox can import `@alexkroman1/aai/{stt,tts,llm}` without pulling
 * in any AI-SDK code, which means no env reads (`ANTHROPIC_BASE_URL`, etc.)
 * at bundle load — the exact failure mode that forced this refactor.
 */

/** Unsubscribe callback returned by `.on()` event subscriptions. */
export type Unsubscribe = () => void;

// -------- Descriptor shape (user-facing, serializable) ----------------------

/**
 * Base shape for a provider descriptor. A `kind` tag + opaque `options`
 * payload lets the host registry pick the right resolver and pass the
 * caller's options through verbatim.
 */
export interface ProviderDescriptor<Kind extends string, Options> {
  readonly kind: Kind;
  readonly options: Options;
}

/**
 * The credential override every provider descriptor accepts.
 *
 * Names an env VARIABLE holding this stage's key, replacing the provider
 * default (`DEEPGRAM_API_KEY`, `ASSEMBLYAI_API_KEY`, …). It names a variable
 * and never a key, so the descriptor stays secret-free and safe to serialize
 * across the CLI → server → guest boundary. The variable must be present in
 * the agent's env (`.env`, or `aai secret put`), like any other credential.
 *
 * @remarks
 * **Every provider options interface extends this, because the host has always
 * honoured the field on every provider.** `descriptorEnvVar()` in
 * `@alexkroman1/aai-runtime` reads `apiKeyEnv` off any descriptor's options
 * through an untyped cast, so all thirteen factories accepted it at runtime
 * while only the four AssemblyAI options types could spell it — a shape that
 * cost `aai:s2s` epoch 1, where the field was added to one stage and left off
 * the rest.
 *
 * The argument for keeping it AssemblyAI-only was that AssemblyAI keys are
 * environment-scoped, so a mixed staging/production pipeline needs two live at
 * once, and no other vendor has that problem. True, and not the whole test: a
 * type that cannot spell what the runtime accepts is wrong regardless of who
 * needs it, and per-stage key separation is equally the answer for two accounts
 * with one vendor, for per-tenant keys, and for a rotation that runs both keys
 * briefly.
 */
export interface ProviderCredentialOptions {
  /**
   * Env var holding this stage's credential, replacing the provider default.
   * Names a VARIABLE, not a key.
   */
  apiKeyEnv?: string;
}

// The `__stage` property on each descriptor alias below is a compile-time
// stage tag, so a descriptor built for one pipeline stage cannot be assigned
// to another — `agent({ stt: cartesiaTts() })` is a type error instead of a
// runtime failure. It is optional and never present at runtime (factories
// don't set it), so plain `{ kind, options }` objects — e.g. configs parsed
// off the wire — remain assignable to every stage.

/**
 * Descriptor for an STT provider. Returned by factories like
 * `assemblyAIStt(...)` from `@alexkroman1/aai/stt`.
 */
export type SttProvider = ProviderDescriptor<string, Record<string, unknown>> & {
  /** Compile-time stage tag; never present at runtime. */
  readonly __stage?: "stt";
};

/**
 * Descriptor for an LLM provider. Returned by factories like
 * `anthropicLlm(...)` from `@alexkroman1/aai/llm`.
 */
export type LlmProvider = ProviderDescriptor<string, Record<string, unknown>> & {
  /** Compile-time stage tag; never present at runtime. */
  readonly __stage?: "llm";
};

/**
 * Descriptor for a TTS provider. Returned by factories like
 * `cartesiaTts(...)` from `@alexkroman1/aai/tts`.
 */
export type TtsProvider = ProviderDescriptor<string, Record<string, unknown>> & {
  /** Compile-time stage tag; never present at runtime. */
  readonly __stage?: "tts";
};

/**
 * Descriptor for an S2S provider. Returned by `assemblyAIS2s(...)` (root
 * export) or `openAIS2s(...)` from `@alexkroman1/aai/s2s`.
 */
export type S2sProvider = ProviderDescriptor<string, Record<string, unknown>> & {
  /** Compile-time stage tag; never present at runtime. */
  readonly __stage?: "s2s";
};

// -------- STT openable (host-only) ------------------------------------------

/**
 * Error raised by an STT provider stream, with a typed `code` naming the
 * failure phase: connecting, authenticating, or mid-stream.
 */
export interface SttError extends Error {
  readonly code: "stt_connect_failed" | "stt_auth_failed" | "stt_stream_error";
}

/** Build an {@link SttError} with a typed `code`. Zero-dep helper so both sdk/ and host/ can use it. */
export function makeSttError(code: SttError["code"], message: string): SttError {
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
   * Push the agent's latest reply text mid-stream so the next user turn is
   * transcribed with that context (e.g. AssemblyAI's `agent_context`, gated
   * to models that support it). Optional: providers that have no equivalent
   * simply omit it, and callers must use `?.()` to invoke it.
   */
  updateAgentContext?(text: string): void;
}

/** Options the host passes when opening an STT stream. */
export interface SttOpenOptions {
  /** Capture sample rate of the inbound PCM, in Hz. */
  sampleRate: number;
  /** Provider API key, resolved from the agent's env. */
  apiKey: string;
  sttPrompt?: string | undefined;
  /**
   * Initial agent-side context to seed at connect time (e.g. the opening
   * greeting), for providers that support it. Providers that don't support
   * it, or whose resolved model doesn't qualify, ignore this.
   */
  agentContext?: string | undefined;
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
  open(opts: SttOpenOptions): Promise<SttSession>;
}

// -------- TTS openable (host-only) ------------------------------------------

/**
 * Error raised by a TTS provider stream, with a typed `code` naming the
 * failure phase: connecting, authenticating, or mid-stream.
 */
export interface TtsError extends Error {
  readonly code: "tts_connect_failed" | "tts_auth_failed" | "tts_stream_error";
}

/** Build a {@link TtsError} with a typed `code`. Mirror of {@link makeSttError}. */
export function makeTtsError(code: TtsError["code"], message: string): TtsError {
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
  open(opts: TtsOpenOptions): Promise<TtsSession>;
}
