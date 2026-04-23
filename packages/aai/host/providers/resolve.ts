// Copyright 2025 the AAI authors. MIT license.
/**
 * Descriptor → concrete-provider resolution (host-only).
 *
 * User code (and the server, after extracting config from a bundled agent)
 * holds `SttProvider` / `LlmProvider` / `TtsProvider` **descriptors** —
 * plain `{ kind, options }` data. At session start the runtime calls the
 * resolvers here to turn each descriptor into its openable / callable
 * host-side counterpart, importing the third-party SDK only at that point.
 *
 * The guest sandbox never imports these functions, which is how the agent
 * bundle stays free of `@ai-sdk/anthropic` / `assemblyai` /
 * `@cartesia/cartesia-js`.
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";
import { ANTHROPIC_KIND, type AnthropicOptions } from "../../sdk/providers/llm/anthropic.ts";
import { ASSEMBLYAI_KIND, type AssemblyAIOptions } from "../../sdk/providers/stt/assemblyai.ts";
import { CARTESIA_KIND, type CartesiaOptions } from "../../sdk/providers/tts/cartesia.ts";
import type {
  LlmProvider,
  SttOpener,
  SttProvider,
  TtsOpener,
  TtsProvider,
} from "../../sdk/providers.ts";
import { openAssemblyAI } from "./stt/assemblyai.ts";
import { openCartesia } from "./tts/cartesia.ts";

/**
 * Look up a provider API key: agent env first (set via `aai secret put` or
 * `.env`), then the host's `process.env` as a fallback for self-hosted mode.
 * Returns `""` if neither has it — the caller decides whether that's fatal.
 */
export function resolveApiKey(envVar: string, env: Record<string, string>): string {
  return env[envVar] ?? process.env[envVar] ?? "";
}

/** Resolve an {@link SttProvider} descriptor into a host-side opener. */
export function resolveStt(descriptor: SttProvider): SttOpener {
  switch (descriptor.kind) {
    case ASSEMBLYAI_KIND:
      return openAssemblyAI(descriptor.options as unknown as AssemblyAIOptions);
    default:
      throw new Error(
        `Unknown STT provider kind: "${descriptor.kind}". Supported: ${ASSEMBLYAI_KIND}.`,
      );
  }
}

/** Resolve a {@link TtsProvider} descriptor into a host-side opener. */
export function resolveTts(descriptor: TtsProvider): TtsOpener {
  switch (descriptor.kind) {
    case CARTESIA_KIND:
      return openCartesia(descriptor.options as unknown as CartesiaOptions);
    default:
      throw new Error(
        `Unknown TTS provider kind: "${descriptor.kind}". Supported: ${CARTESIA_KIND}.`,
      );
  }
}

/**
 * Resolve an {@link LlmProvider} descriptor into a Vercel AI SDK
 * {@link LanguageModel}.
 *
 * The API key is pulled from the agent's env (e.g. `ANTHROPIC_API_KEY`).
 * Missing keys throw here — the pipeline session would fail on first
 * `streamText` call otherwise, and the error is clearer at construction.
 */
export function resolveLlm(descriptor: LlmProvider, env: Record<string, string>): LanguageModel {
  switch (descriptor.kind) {
    case ANTHROPIC_KIND: {
      const options = descriptor.options as unknown as AnthropicOptions;
      const apiKey = resolveApiKey("ANTHROPIC_API_KEY", env);
      if (!apiKey) {
        throw new Error("Anthropic LLM: missing API key. Set ANTHROPIC_API_KEY in the agent env.");
      }
      return createAnthropic({ apiKey })(options.model);
    }
    default:
      throw new Error(
        `Unknown LLM provider kind: "${descriptor.kind}". Supported: ${ANTHROPIC_KIND}.`,
      );
  }
}
