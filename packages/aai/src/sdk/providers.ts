// Copyright 2025 the AAI authors. MIT license.
/**
 * Pluggable provider contracts.
 *
 * **Two layers, strict boundary.**
 *
 * - The *descriptor* layer (`SttProvider` / `LlmProvider` / `TtsProvider`) is
 *   pure data — `{ kind, options }` objects returned by the user-facing
 *   factories (`assemblyAIStt(...)`, `llm({ provider: "anthropic", ... })`, `cartesiaTts(...)`). They
 *   are JSON-serializable, contain no functions, and can cross the CLI →
 *   server → guest boundary without evaluating any third-party SDK.
 *   They live in `sdk/` alongside `Manifest` and have zero Node-only deps.
 *
 * - The *openable* layer (`SttOpener` / `TtsOpener` + `SttSession` /
 *   `TtsSession`) is host-only, and is DECLARED in the host as well:
 *   `@alexkroman1/aai-runtime`'s `providers/openers.ts`, whose registry
 *   turns descriptors into openers during `createRuntime`, importing the
 *   concrete SDKs (`assemblyai`, `@cartesia/cartesia-js`,
 *   `@ai-sdk/anthropic`) only at that point. Nothing in this package uses
 *   an opener type, so none is declared here.
 *   Only the openable layer talks to the network; descriptors never do.
 *
 * This split is load-bearing for the sandboxed deployment path: the guest
 * sandbox can import `@alexkroman1/aai/{stt,tts,llm}` without pulling
 * in any AI-SDK code, which means no env reads (`ANTHROPIC_BASE_URL`, etc.)
 * at bundle load — the exact failure mode that forced this refactor.
 */

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
 * cost the `aai:s2s` contract an epoch, where the field was added to one stage
 * and left off the rest.
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
 * What an {@link LlmProvider} descriptor's `options` carry — the one shape
 * `llm()` writes and the host resolver reads.
 *
 * Declared ONCE, here, because it used to be declared twice: the descriptor
 * carried `Record<string, unknown>` and the runtime re-declared this shape and
 * read it through an unchecked cast, so a field renamed on one side compiled on
 * both. A type alias rather than an interface so it stays assignable to
 * `Record<string, unknown>` (an interface has no implicit index signature).
 *
 * `providerOptions` is the per-provider settings bag; `llm()` narrows it per
 * provider (see `LlmOptions`), and the resolver validates the fields it
 * consumes rather than trusting a type the wire does not carry.
 */
export type LlmDescriptorOptions = {
  /** The provider's own model id. */
  readonly model: string;
  /** Replaces the provider's endpoint; must include the version path. */
  readonly baseUrl?: string;
  /** Env var holding this stage's credential — see {@link ProviderCredentialOptions}. */
  readonly apiKeyEnv?: string;
  /** Provider-specific settings, forwarded per the provider's entry. */
  readonly providerOptions?: Readonly<Record<string, unknown>>;
};

/**
 * Descriptor for an LLM provider. Returned by factories like
 * `llm({ provider: "anthropic", ... })` from `@alexkroman1/aai/llm`.
 */
export type LlmProvider = ProviderDescriptor<string, LlmDescriptorOptions> & {
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
