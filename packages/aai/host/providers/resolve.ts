// Copyright 2025 the AAI authors. MIT license.
/**
 * Descriptor → concrete-provider resolution (host-only).
 *
 * User code (and the server, after extracting config from a bundled agent)
 * holds `SttProvider` / `LlmProvider` / `TtsProvider` **descriptors** —
 * plain `{ kind, options }` data. At session start the runtime calls the
 * resolvers here to turn each descriptor into its openable / callable
 * host-side counterpart.
 *
 * The guest sandbox never imports these functions, which is how the agent
 * bundle stays free of `@ai-sdk/anthropic` / `assemblyai` /
 * `@cartesia/cartesia-js`.
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { createMistral } from "@ai-sdk/mistral";
import { createOpenAI } from "@ai-sdk/openai";
import { createXai } from "@ai-sdk/xai";
import type { LanguageModel } from "ai";
import { ANTHROPIC_KIND, type AnthropicOptions } from "../../sdk/providers/llm/anthropic.ts";
import { GOOGLE_KIND, type GoogleOptions } from "../../sdk/providers/llm/google.ts";
import { GROQ_KIND, type GroqOptions } from "../../sdk/providers/llm/groq.ts";
import { MISTRAL_KIND, type MistralOptions } from "../../sdk/providers/llm/mistral.ts";
import { OPENAI_KIND, type OpenAIOptions } from "../../sdk/providers/llm/openai.ts";
import { XAI_KIND, type XaiOptions } from "../../sdk/providers/llm/xai.ts";
import { ASSEMBLYAI_KIND, type AssemblyAIOptions } from "../../sdk/providers/stt/assemblyai.ts";
import { DEEPGRAM_KIND, type DeepgramOptions } from "../../sdk/providers/stt/deepgram.ts";
import { ELEVENLABS_KIND, type ElevenLabsOptions } from "../../sdk/providers/stt/elevenlabs.ts";
import { SONIOX_KIND, type SonioxOptions } from "../../sdk/providers/stt/soniox.ts";
import { CARTESIA_KIND, type CartesiaOptions } from "../../sdk/providers/tts/cartesia.ts";
import { RIME_KIND, type RimeOptions } from "../../sdk/providers/tts/rime.ts";
import type {
  LlmProvider,
  SttOpener,
  SttProvider,
  TtsOpener,
  TtsProvider,
} from "../../sdk/providers.ts";
import { openAssemblyAI } from "./stt/assemblyai.ts";
import { openDeepgram } from "./stt/deepgram.ts";
import { openElevenLabs } from "./stt/elevenlabs.ts";
import { openSoniox } from "./stt/soniox.ts";
import { openCartesia } from "./tts/cartesia.ts";
import { openRime } from "./tts/rime.ts";

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
    case DEEPGRAM_KIND:
      return openDeepgram(descriptor.options as unknown as DeepgramOptions);
    case ELEVENLABS_KIND:
      return openElevenLabs(descriptor.options as unknown as ElevenLabsOptions);
    case SONIOX_KIND:
      return openSoniox(descriptor.options as unknown as SonioxOptions);
    default:
      throw new Error(
        `Unknown STT provider kind: "${descriptor.kind}". ` +
          `Supported: ${ASSEMBLYAI_KIND}, ${DEEPGRAM_KIND}, ${ELEVENLABS_KIND}, ${SONIOX_KIND}.`,
      );
  }
}

/** Resolve a {@link TtsProvider} descriptor into a host-side opener. */
export function resolveTts(descriptor: TtsProvider): TtsOpener {
  switch (descriptor.kind) {
    case CARTESIA_KIND:
      return openCartesia(descriptor.options as unknown as CartesiaOptions);
    case RIME_KIND:
      return openRime(descriptor.options as unknown as RimeOptions);
    default:
      throw new Error(
        `Unknown TTS provider kind: "${descriptor.kind}". Supported: ${CARTESIA_KIND}, ${RIME_KIND}.`,
      );
  }
}

/**
 * Resolve an {@link LlmProvider} descriptor into a Vercel AI SDK
 * {@link LanguageModel}.
 *
 * The API key is pulled from the agent's env (e.g. `OPENAI_API_KEY`).
 * Missing keys throw here — the pipeline session would fail on first
 * `streamText` call otherwise, and the error is clearer at construction.
 */
export function resolveLlm(descriptor: LlmProvider, env: Record<string, string>): LanguageModel {
  switch (descriptor.kind) {
    case ANTHROPIC_KIND: {
      const apiKey = requireKey(env, "ANTHROPIC_API_KEY", "Anthropic");
      // Pass baseURL explicitly so the SDK's loadOptionalSetting returns
      // before reading process.env["ANTHROPIC_BASE_URL"]. Without this,
      // the Deno platform server needs --allow-env to start a session.
      return createAnthropic({ apiKey, baseURL: "https://api.anthropic.com/v1" })(
        (descriptor.options as unknown as AnthropicOptions).model,
      );
    }
    case OPENAI_KIND: {
      const apiKey = requireKey(env, "OPENAI_API_KEY", "OpenAI");
      return createOpenAI({ apiKey })((descriptor.options as unknown as OpenAIOptions).model);
    }
    case GOOGLE_KIND: {
      const apiKey = requireKey(env, "GOOGLE_GENERATIVE_AI_API_KEY", "Google");
      return createGoogleGenerativeAI({ apiKey })(
        (descriptor.options as unknown as GoogleOptions).model,
      );
    }
    case MISTRAL_KIND: {
      const apiKey = requireKey(env, "MISTRAL_API_KEY", "Mistral");
      return createMistral({ apiKey })((descriptor.options as unknown as MistralOptions).model);
    }
    case XAI_KIND: {
      const apiKey = requireKey(env, "XAI_API_KEY", "xAI");
      return createXai({ apiKey })((descriptor.options as unknown as XaiOptions).model);
    }
    case GROQ_KIND: {
      const apiKey = requireKey(env, "GROQ_API_KEY", "Groq");
      return createGroq({ apiKey })((descriptor.options as unknown as GroqOptions).model);
    }
    default:
      throw new Error(
        `Unknown LLM provider kind: "${descriptor.kind}". ` +
          `Supported: ${ANTHROPIC_KIND}, ${OPENAI_KIND}, ${GOOGLE_KIND}, ${MISTRAL_KIND}, ${XAI_KIND}, ${GROQ_KIND}.`,
      );
  }
}

// ── Helpers ───────────────────────────────────────────────────────────

function requireKey(env: Record<string, string>, name: string, label: string): string {
  const key = resolveApiKey(name, env);
  if (!key) {
    throw new Error(`${label} LLM: missing API key. Set ${name} in the agent env.`);
  }
  return key;
}
