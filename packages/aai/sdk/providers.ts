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

/** Descriptor for a KV provider. Returned by factories like `upstash(...)`. */
export type KvProvider = ProviderDescriptor<string, Record<string, unknown>>;

/** Descriptor for a Vector provider. Returned by factories like `pinecone(...)`. */
export type VectorProvider = ProviderDescriptor<string, Record<string, unknown>>;

/**
 * Session mode derived from which provider triple is set.
 *
 * `parseManifest`, `toAgentConfig`, `createRuntime`, and the server's
 * `IsolateConfigSchema` all use {@link assertProviderTriple} so there's
 * one source of truth for the validation.
 */
export type SessionMode = "s2s" | "pipeline";

/**
 * Enforce the all-or-nothing provider rule and return the derived mode.
 *
 * Pipeline mode requires STT, LLM, and TTS all set; S2S mode requires
 * none of them. Anything in-between is a configuration error.
 */
export function assertProviderTriple(stt: unknown, llm: unknown, tts: unknown): SessionMode {
  const count = (stt != null ? 1 : 0) + (llm != null ? 1 : 0) + (tts != null ? 1 : 0);
  if (count !== 0 && count !== 3) {
    throw new Error("stt, llm, and tts must be set together");
  }
  return count === 3 ? "pipeline" : "s2s";
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
}

export interface SttOpenOptions {
  sampleRate: number;
  apiKey: string;
  sttPrompt?: string | undefined;
  signal: AbortSignal;
}

/** Host-side openable STT provider — produced by `resolveStt(descriptor)`. */
export interface SttOpener {
  readonly name: string;
  open(opts: SttOpenOptions): Promise<SttSession>;
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
  /** Synthesis drained after flush() or cancel(). Emitted exactly once per turn. */
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

/** Host-side openable TTS provider — produced by `resolveTts(descriptor)`. */
export interface TtsOpener {
  readonly name: string;
  open(opts: TtsOpenOptions): Promise<TtsSession>;
}
