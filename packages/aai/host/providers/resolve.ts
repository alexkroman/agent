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

import { createRequire } from "node:module";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { createMistral } from "@ai-sdk/mistral";
import { createOpenAI } from "@ai-sdk/openai";
import { createXai } from "@ai-sdk/xai";
import type { LanguageModel } from "ai";
import { ANTHROPIC_KIND } from "../../sdk/providers/llm/anthropic.ts";
import { GOOGLE_KIND } from "../../sdk/providers/llm/google.ts";
import { GROQ_KIND } from "../../sdk/providers/llm/groq.ts";
import { MISTRAL_KIND } from "../../sdk/providers/llm/mistral.ts";
import { OPENAI_KIND } from "../../sdk/providers/llm/openai.ts";
import { XAI_KIND } from "../../sdk/providers/llm/xai.ts";
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

export function options<T>(descriptor: { options: Record<string, unknown> }): T {
  return descriptor.options as unknown as T;
}

/** Resolve an {@link SttProvider} descriptor into a host-side opener. */
export function resolveStt(descriptor: SttProvider): SttOpener {
  switch (descriptor.kind) {
    case ASSEMBLYAI_KIND:
      return openAssemblyAI(options<AssemblyAIOptions>(descriptor));
    case DEEPGRAM_KIND:
      return openDeepgram(options<DeepgramOptions>(descriptor));
    case ELEVENLABS_KIND:
      return openElevenLabs(options<ElevenLabsOptions>(descriptor));
    case SONIOX_KIND:
      return openSoniox(options<SonioxOptions>(descriptor));
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
      return openCartesia(options<CartesiaOptions>(descriptor));
    case RIME_KIND:
      return openRime(options<RimeOptions>(descriptor));
    default:
      throw new Error(
        `Unknown TTS provider kind: "${descriptor.kind}". Supported: ${CARTESIA_KIND}, ${RIME_KIND}.`,
      );
  }
}

// Each entry: the env var name, display label, and a factory that accepts an
// apiKey and returns a (model: string) => LanguageModel callable.
type LlmEntry = {
  envVar: string;
  label: string;
  factory: (apiKey: string) => (model: string) => LanguageModel;
};

const LLM_REGISTRY: Partial<Record<string, LlmEntry>> = {
  [ANTHROPIC_KIND]: {
    envVar: "ANTHROPIC_API_KEY",
    label: "Anthropic",
    // Pass baseURL explicitly so the SDK's loadOptionalSetting returns before
    // reading process.env["ANTHROPIC_BASE_URL"]. Without this, the Deno
    // platform server needs --allow-env to start a session.
    factory: (apiKey) => createAnthropic({ apiKey, baseURL: "https://api.anthropic.com/v1" }),
  },
  [OPENAI_KIND]: {
    envVar: "OPENAI_API_KEY",
    label: "OpenAI",
    factory: (apiKey) => createOpenAI({ apiKey }),
  },
  [GOOGLE_KIND]: {
    envVar: "GOOGLE_GENERATIVE_AI_API_KEY",
    label: "Google",
    factory: (apiKey) => createGoogleGenerativeAI({ apiKey }),
  },
  [MISTRAL_KIND]: {
    envVar: "MISTRAL_API_KEY",
    label: "Mistral",
    factory: (apiKey) => createMistral({ apiKey }),
  },
  [XAI_KIND]: {
    envVar: "XAI_API_KEY",
    label: "xAI",
    factory: (apiKey) => createXai({ apiKey }),
  },
  [GROQ_KIND]: {
    envVar: "GROQ_API_KEY",
    label: "Groq",
    factory: (apiKey) => createGroq({ apiKey }),
  },
};

/**
 * Resolve an {@link LlmProvider} descriptor into a Vercel AI SDK
 * {@link LanguageModel}.
 *
 * The API key is pulled from the agent's env (e.g. `OPENAI_API_KEY`).
 * Missing keys throw here — the pipeline session would fail on first
 * `streamText` call otherwise, and the error is clearer at construction.
 */
export function resolveLlm(descriptor: LlmProvider, env: Record<string, string>): LanguageModel {
  const entry = LLM_REGISTRY[descriptor.kind];
  if (!entry) {
    throw new Error(
      `Unknown LLM provider kind: "${descriptor.kind}". ` +
        `Supported: ${ANTHROPIC_KIND}, ${OPENAI_KIND}, ${GOOGLE_KIND}, ${MISTRAL_KIND}, ${XAI_KIND}, ${GROQ_KIND}.`,
    );
  }
  const apiKey = requireKey(env, entry.envVar, entry.label);
  return entry.factory(apiKey)(options<{ model: string }>(descriptor).model);
}

// ── Helpers ───────────────────────────────────────────────────────────

const requireFromHere = createRequire(import.meta.url);

/**
 * Lazy-load a package via createRequire so the package is a true optional
 * peer dependency — if it's not installed the error surfaces only when the
 * provider is actually used, not at module load time.
 */
export function loadProviderPackage<T>(name: string, label: string): T {
  try {
    return requireFromHere(name) as T;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    const isMissing =
      (code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND") &&
      (err as Error)?.message?.includes(name);
    if (!isMissing) throw err;
    throw new Error(`${label}: package \`${name}\` is not installed. Run \`pnpm add ${name}\`.`, {
      cause: err,
    });
  }
}

export function requireKey(env: Record<string, string>, name: string, label: string): string {
  const key = resolveApiKey(name, env);
  if (!key) {
    throw new Error(`${label} LLM: missing API key. Set ${name} in the agent env.`);
  }
  return key;
}
