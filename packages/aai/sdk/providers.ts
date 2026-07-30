// Copyright 2025 the AAI authors. MIT license.
/**
 * Pluggable provider contracts.
 *
 * **Two layers, strict boundary.**
 *
 * - The *descriptor* layer (`SttProvider` / `LlmProvider` / `TtsProvider`) is
 *   pure data — `{ kind, options }` objects returned by the user-facing
 *   factories (`assemblyAI(...)`, `anthropic(...)`, `cartesia(...)`). They
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
 * Deno sandbox can import `@alexkroman1/aai/{stt,tts,llm}` without pulling
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

/** Descriptor for an STT provider. Returned by factories like `assemblyAI(...)`. */
export type SttProvider = ProviderDescriptor<string, Record<string, unknown>>;

/** Descriptor for an LLM provider. Returned by factories like `anthropic(...)`. */
export type LlmProvider = ProviderDescriptor<string, Record<string, unknown>>;

/** Descriptor for a TTS provider. Returned by factories like `cartesia(...)`. */
export type TtsProvider = ProviderDescriptor<string, Record<string, unknown>>;

/** Descriptor for an S2S provider. Returned by factories like `openaiRealtime(...)`. */
export type S2sProvider = ProviderDescriptor<string, Record<string, unknown>>;

/** Descriptor for a KV backend. Returned by factories like `redisKv()`. */
export type KvProvider = ProviderDescriptor<string, Record<string, unknown>>;

/** Descriptor for an outbound send channel. Returned by factories like `slack()`. */
export type SendProvider = ProviderDescriptor<string, Record<string, unknown>>;

/** Descriptor for a Vector backend. Returned by factories like `pinecone(...)`. */
export type VectorProvider = ProviderDescriptor<string, Record<string, unknown>>;

// -------- Send channel (environment-agnostic) --------------------------------

/**
 * Payload for a send channel. A string is wrapped in the channel's natural
 * text shape (Slack: `{ text }`); an object is posted verbatim as the HTTP
 * body, so callers control the full payload (Slack blocks, attachments, …).
 */
export type SendMessage = string | Record<string, unknown>;

/**
 * A live outbound channel resolved from a {@link SendProvider} descriptor
 * via `openSender` (`@alexkroman1/aai/send`). Unlike the STT/TTS openables
 * this is not host-only: senders are plain `fetch` + env, so the same
 * implementation runs on the host and inside the guest sandbox (where
 * `fetch` is the harness's proxied, allowlist-checked implementation).
 */
export interface Sender {
  /** The provider kind this sender was resolved from (e.g. `"slack"`). */
  readonly name: string;
  /** Deliver one message. Rejects on missing credential or non-2xx response. */
  send(message: SendMessage, opts?: { signal?: AbortSignal | undefined }): Promise<void>;
}

// -------- STT openable (host-only) ------------------------------------------

export interface SttError extends Error {
  readonly code: "stt_connect_failed" | "stt_auth_failed" | "stt_stream_error";
}

/** Build an {@link SttError} with a typed `code`. Zero-dep helper so both sdk/ and host/ can use it. */
export function makeSttError(code: SttError["code"], message: string): SttError {
  return Object.assign(new Error(message), { code }) as SttError;
}

export type SttEvents = {
  /** Interim transcript; drives barge-in detection. */
  partial: (text: string) => void;
  /** End-of-turn final transcript; cue to run the LLM. */
  final: (text: string) => void;
  /** Terminal error. The session is expected to end after this fires. */
  error: (err: SttError) => void;
};

export interface SttSession {
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

export interface SttOpenOptions {
  sampleRate: number;
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

/** Options for {@link SttOpener.transcribeClip}. */
export interface TranscribeClipOptions {
  apiKey: string;
  fetch?: typeof globalThis.fetch | undefined;
  signal?: AbortSignal | undefined;
}

/** Host-side openable STT provider — produced by `resolveStt(descriptor)`. */
export interface SttOpener {
  readonly name: string;
  open(opts: SttOpenOptions): Promise<SttSession>;
  /**
   * One-shot transcription of a short PCM16 clip (an uploaded file), for
   * providers with a synchronous batch endpoint — AssemblyAI implements it
   * via the Sync API. Providers without one omit it; the pipeline transport
   * then replays the clip through the realtime session instead.
   */
  transcribeClip?(
    pcm: Uint8Array,
    sampleRate: number,
    opts: TranscribeClipOptions,
  ): Promise<string>;
}

// -------- TTS openable (host-only) ------------------------------------------

export interface TtsError extends Error {
  readonly code: "tts_connect_failed" | "tts_auth_failed" | "tts_stream_error";
}

/** Build a {@link TtsError} with a typed `code`. Mirror of {@link makeSttError}. */
export function makeTtsError(code: TtsError["code"], message: string): TtsError {
  return Object.assign(new Error(message), { code }) as TtsError;
}

export type TtsEvents = {
  /** One PCM16 audio chunk. Orchestrator forwards to the client. */
  audio: (pcm: Int16Array) => void;
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

export interface TtsOpenOptions {
  sampleRate: number;
  apiKey: string;
  signal: AbortSignal;
}

/** Options for {@link TtsOpener.synthesizeClip}. */
export interface SynthesizeClipOptions {
  /** Sample rate of the returned PCM16 audio, in Hz. */
  sampleRate: number;
  apiKey: string;
  fetch?: typeof globalThis.fetch | undefined;
  signal?: AbortSignal | undefined;
}

/** Host-side openable TTS provider — produced by `resolveTts(descriptor)`. */
export interface TtsOpener {
  readonly name: string;
  open(opts: TtsOpenOptions): Promise<TtsSession>;
  /**
   * One-shot synthesis of a complete reply into mono PCM16LE bytes, for
   * providers with a synchronous HTTP endpoint — Cartesia implements it via
   * `/tts/bytes`. The mirror of {@link SttOpener.transcribeClip}: sync turns
   * (`POST /sync`) use it instead of opening a streaming session. Providers
   * without one omit it; a sync turn then returns a text-only reply.
   */
  synthesizeClip?(text: string, opts: SynthesizeClipOptions): Promise<Uint8Array>;
}
