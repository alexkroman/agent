// Copyright 2026 the AAI authors. MIT license.
/**
 * The AssemblyAI LLM Gateway model catalog.
 *
 * GENERATED — run `node scripts/gen-gateway-models.mjs --write` to refresh,
 * and `pnpm check:gateway-models` to verify. Do not hand-edit: every
 * hand-maintained version of this list was wrong. One carried a deprecated
 * model and one that had never existed while missing nine real ones; another
 * inferred EU availability from id prefixes and produced four models the EU
 * endpoint does not serve.
 *
 * Capabilities come from the endpoint's `supported_parameters` and are not
 * decoration:
 *
 * - `stream: false` cannot be used for a voice pipeline or a studio turn at
 *   all — both stream. Two listed models are in this category.
 * - `tools: false` cannot run an agent that has tools.
 *
 * A model being listed here means the gateway advertises it, which is a
 * weaker claim than it working: `kimi-k2.5` is advertised and answers 410.
 * That is why the check script probes rather than trusting this file.
 *
 * Only the id UNION is published, on `@alexkroman1/aai/llm`, because
 * `AssemblyAILlmOptions.model` narrows to it for autocomplete. The catalog
 * itself, its row type and `gatewayModelIds` are on
 * `@alexkroman1/aai/host-internal`: their reader is the studio's model
 * selection and this repo's own gate, never an `agent.ts`.
 */

export type GatewayModelInfo = {
  /** Accepts a `tools` array — required for any agent with tools. */
  readonly tools: boolean;
  /** Supports `stream: true` — required for voice pipelines and studio chat. */
  readonly stream: boolean;
  /** Served by the EU endpoint (`llm-gateway.eu.assemblyai.com`). */
  readonly eu: boolean;
  /**
   * Answered a minimal request, as this SDK sends one, when generated.
   * `false` means the gateway advertises the model and will not run it for
   * us: `kimi-k2.5` answers 410 (deprecated), `gemini-3.6-flash` answers
   * 400 (needs a `model_region` parameter nothing here sends).
   */
  readonly live: boolean;
  /** Context window in tokens, as the gateway reports it. */
  readonly context: number;
};

/** An id the gateway advertises. */
export type AssemblyAIGatewayModel =
  | "claude-haiku-4-5-20251001"
  | "claude-opus-4-5-20251101"
  | "claude-opus-4-6"
  | "claude-opus-4-7"
  | "claude-opus-4-8"
  | "claude-sonnet-4-5-20250929"
  | "claude-sonnet-4-6"
  | "claude-sonnet-5"
  | "gemini-2.5-flash"
  | "gemini-2.5-flash-lite"
  | "gemini-2.5-pro"
  | "gemini-3.1-flash-lite"
  | "gemini-3.5-flash"
  | "gemini-3.5-flash-lite"
  | "gemini-3.6-flash"
  | "gpt-4.1"
  | "gpt-5"
  | "gpt-5-mini"
  | "gpt-5-nano"
  | "gpt-5.1"
  | "gpt-5.2"
  | "gpt-5.5"
  | "gpt-5.6-luna"
  | "gpt-5.6-terra"
  | "gpt-oss-120b"
  | "gpt-oss-20b"
  | "kimi-k2.5"
  | "qwen3-32B"
  | "qwen3-next-80b-a3b"
  | "qwen3.5-4b-32k-experimental";

export const ASSEMBLYAI_GATEWAY_MODELS = {
  "claude-haiku-4-5-20251001": {
    tools: true,
    stream: true,
    eu: true,
    live: true,
    context: 200_000,
  },
  "claude-opus-4-5-20251101": {
    tools: true,
    stream: true,
    eu: false,
    live: true,
    context: 200_000,
  },
  "claude-opus-4-6": { tools: true, stream: true, eu: false, live: true, context: 200_000 },
  "claude-opus-4-7": { tools: true, stream: true, eu: false, live: true, context: 1_000_000 },
  "claude-opus-4-8": { tools: true, stream: true, eu: false, live: true, context: 1_000_000 },
  "claude-sonnet-4-5-20250929": {
    tools: true,
    stream: true,
    eu: true,
    live: true,
    context: 200_000,
  },
  "claude-sonnet-4-6": { tools: true, stream: true, eu: true, live: true, context: 200_000 },
  "claude-sonnet-5": { tools: true, stream: true, eu: false, live: true, context: 200_000 },
  "gemini-2.5-flash": { tools: true, stream: true, eu: true, live: true, context: 1_048_576 },
  "gemini-2.5-flash-lite": { tools: true, stream: true, eu: true, live: true, context: 1_048_576 },
  "gemini-2.5-pro": { tools: true, stream: true, eu: true, live: true, context: 200_000 },
  "gemini-3.1-flash-lite": { tools: true, stream: true, eu: false, live: true, context: 1_048_575 },
  "gemini-3.5-flash": { tools: true, stream: true, eu: false, live: true, context: 1_048_575 },
  "gemini-3.5-flash-lite": { tools: true, stream: true, eu: false, live: true, context: 1_048_575 },
  "gemini-3.6-flash": { tools: true, stream: true, eu: false, live: false, context: 1_048_575 },
  "gpt-4.1": { tools: true, stream: true, eu: false, live: true, context: 1_047_576 },
  "gpt-5": { tools: true, stream: true, eu: false, live: true, context: 400_000 },
  "gpt-5-mini": { tools: true, stream: true, eu: false, live: true, context: 400_000 },
  "gpt-5-nano": { tools: true, stream: true, eu: false, live: true, context: 400_000 },
  "gpt-5.1": { tools: true, stream: true, eu: false, live: true, context: 400_000 },
  "gpt-5.2": { tools: true, stream: true, eu: false, live: true, context: 400_000 },
  "gpt-5.5": { tools: true, stream: true, eu: false, live: true, context: 272_000 },
  "gpt-5.6-luna": { tools: true, stream: true, eu: false, live: true, context: 270_000 },
  "gpt-5.6-terra": { tools: true, stream: true, eu: false, live: true, context: 270_000 },
  "gpt-oss-120b": { tools: true, stream: false, eu: false, live: true, context: 131_072 },
  "gpt-oss-20b": { tools: true, stream: false, eu: false, live: true, context: 131_072 },
  "kimi-k2.5": { tools: true, stream: true, eu: false, live: false, context: 200_000 },
  "qwen3-32B": { tools: true, stream: true, eu: false, live: true, context: 200_000 },
  "qwen3-next-80b-a3b": { tools: true, stream: true, eu: false, live: true, context: 200_000 },
  "qwen3.5-4b-32k-experimental": {
    tools: false,
    stream: true,
    eu: false,
    live: true,
    context: 32_768,
  },
} as const satisfies Record<AssemblyAIGatewayModel, GatewayModelInfo>;

/**
 * Ids usable for a streaming, tool-calling agent — the only shape this SDK
 * runs — and that actually answer. Deriving it beats another hand-kept list:
 * a model that is deprecated or loses `stream` upstream drops out on the
 * next regeneration instead of waiting to be noticed.
 */
export function gatewayModelIds(opts: { eu?: boolean } = {}): AssemblyAIGatewayModel[] {
  return (Object.entries(ASSEMBLYAI_GATEWAY_MODELS) as [AssemblyAIGatewayModel, GatewayModelInfo][])
    .filter(([, m]) => m.live && m.tools && m.stream && (!opts.eu || m.eu))
    .map(([id]) => id);
}
