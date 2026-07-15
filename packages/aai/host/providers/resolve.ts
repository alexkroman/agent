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
import { ANTHROPIC_API_KEY_ENV, ANTHROPIC_KIND } from "../../sdk/providers/llm/anthropic.ts";
import {
  ASSEMBLYAI_LLM_API_KEY_ENV,
  ASSEMBLYAI_LLM_GATEWAY_EU_URL,
  ASSEMBLYAI_LLM_GATEWAY_URL,
  ASSEMBLYAI_LLM_KIND,
  type AssemblyAILlmOptions,
} from "../../sdk/providers/llm/assemblyai.ts";
import { GOOGLE_API_KEY_ENV, GOOGLE_KIND } from "../../sdk/providers/llm/google.ts";
import { GROQ_API_KEY_ENV, GROQ_KIND } from "../../sdk/providers/llm/groq.ts";
import { MISTRAL_API_KEY_ENV, MISTRAL_KIND } from "../../sdk/providers/llm/mistral.ts";
import { OPENAI_API_KEY_ENV, OPENAI_KIND } from "../../sdk/providers/llm/openai.ts";
import { XAI_API_KEY_ENV, XAI_KIND } from "../../sdk/providers/llm/xai.ts";
import {
  ASSEMBLYAI_API_KEY_ENV,
  ASSEMBLYAI_KIND,
  type AssemblyAIOptions,
} from "../../sdk/providers/stt/assemblyai.ts";
import {
  DEEPGRAM_API_KEY_ENV,
  DEEPGRAM_KIND,
  type DeepgramOptions,
} from "../../sdk/providers/stt/deepgram.ts";
import {
  ELEVENLABS_API_KEY_ENV,
  ELEVENLABS_KIND,
  type ElevenLabsOptions,
} from "../../sdk/providers/stt/elevenlabs.ts";
import {
  SONIOX_API_KEY_ENV,
  SONIOX_KIND,
  type SonioxOptions,
} from "../../sdk/providers/stt/soniox.ts";
import {
  CARTESIA_API_KEY_ENV,
  CARTESIA_KIND,
  type CartesiaOptions,
} from "../../sdk/providers/tts/cartesia.ts";
import { RIME_API_KEY_ENV, RIME_KIND, type RimeOptions } from "../../sdk/providers/tts/rime.ts";
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

function options<T>(descriptor: { options: Record<string, unknown> }): T {
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

/** One registry entry per LLM provider kind — adding a provider is one entry here. */
type LlmRegistryEntry = {
  readonly envVar: string;
  readonly label: string;
  readonly create: (apiKey: string, descriptor: LlmProvider) => LanguageModel;
};

function model(descriptor: LlmProvider): string {
  return options<{ model: string }>(descriptor).model;
}

const LLM_REGISTRY: Record<string, LlmRegistryEntry> = {
  [ANTHROPIC_KIND]: {
    envVar: ANTHROPIC_API_KEY_ENV,
    label: "Anthropic",
    // Pass baseURL explicitly so the SDK's loadOptionalSetting returns
    // before reading process.env["ANTHROPIC_BASE_URL"]. Without this,
    // the Deno platform server needs --allow-env to start a session.
    create: (apiKey, d) =>
      createAnthropic({ apiKey, baseURL: "https://api.anthropic.com/v1" })(model(d)),
  },
  [OPENAI_KIND]: {
    envVar: OPENAI_API_KEY_ENV,
    label: "OpenAI",
    create: (apiKey, d) => createOpenAI({ apiKey })(model(d)),
  },
  [GOOGLE_KIND]: {
    envVar: GOOGLE_API_KEY_ENV,
    label: "Google",
    create: (apiKey, d) => createGoogleGenerativeAI({ apiKey })(model(d)),
  },
  [MISTRAL_KIND]: {
    envVar: MISTRAL_API_KEY_ENV,
    label: "Mistral",
    create: (apiKey, d) => createMistral({ apiKey })(model(d)),
  },
  [XAI_KIND]: {
    envVar: XAI_API_KEY_ENV,
    label: "xAI",
    create: (apiKey, d) => createXai({ apiKey })(model(d)),
  },
  [GROQ_KIND]: {
    envVar: GROQ_API_KEY_ENV,
    label: "Groq",
    create: (apiKey, d) => createGroq({ apiKey })(model(d)),
  },
  [ASSEMBLYAI_LLM_KIND]: {
    envVar: ASSEMBLYAI_LLM_API_KEY_ENV,
    label: "AssemblyAI",
    create: (apiKey, d) => {
      const opts = options<AssemblyAILlmOptions>(d);
      const baseURL =
        opts.region === "eu" ? ASSEMBLYAI_LLM_GATEWAY_EU_URL : ASSEMBLYAI_LLM_GATEWAY_URL;
      // The gateway implements /chat/completions only, so use .chat() —
      // the provider's default callable targets OpenAI's Responses API.
      return createOpenAI({ apiKey, baseURL, name: "assemblyai" }).chat(opts.model);
    },
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
        `Supported: ${Object.keys(LLM_REGISTRY).join(", ")}.`,
    );
  }
  const apiKey = requireKey(env, entry.envVar, entry.label);
  return entry.create(apiKey, descriptor);
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
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    const isMissing =
      err instanceof Error &&
      (code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND") &&
      err.message.includes(name);
    if (!isMissing) throw err;
    throw new Error(`${label}: package \`${name}\` is not installed. Run \`pnpm add ${name}\`.`, {
      cause: err,
    });
  }
}

function requireKey(env: Record<string, string>, name: string, label: string): string {
  const key = resolveApiKey(name, env);
  if (!key) {
    throw new Error(`${label} LLM: missing API key. Set ${name} in the agent env.`);
  }
  return key;
}

// ─── API-key routing + descriptor→instance helpers (used by runtime.ts) ──────

/**
 * Read the descriptor `kind` if present. Pre-resolved openers (test escape
 * hatch) have no `kind` field, so callers fall back to a default env var.
 */
export function descriptorKind(value: object | undefined): string | undefined {
  const kind = (value as { kind?: unknown } | undefined)?.kind;
  return typeof kind === "string" ? kind : undefined;
}

/**
 * Provider kind → the agent-env variable that holds its API key. The env-var
 * names are defined once, next to each provider's `KIND` in `sdk/providers/`.
 */
const STT_API_KEY_ENV: Record<string, string> = {
  [ASSEMBLYAI_KIND]: ASSEMBLYAI_API_KEY_ENV,
  [DEEPGRAM_KIND]: DEEPGRAM_API_KEY_ENV,
  [ELEVENLABS_KIND]: ELEVENLABS_API_KEY_ENV,
  [SONIOX_KIND]: SONIOX_API_KEY_ENV,
};

const TTS_API_KEY_ENV: Record<string, string> = {
  [CARTESIA_KIND]: CARTESIA_API_KEY_ENV,
  [RIME_KIND]: RIME_API_KEY_ENV,
};

/** Resolve the agent-env API key for an STT descriptor by its kind. */
export function resolveSttApiKey(
  stt: SttProvider | SttOpener | undefined,
  env: Record<string, string>,
): string {
  // Default to AssemblyAI for pre-resolved openers (test escape hatch) that
  // carry no `kind`; every real descriptor maps to its own env var.
  return resolveApiKey(STT_API_KEY_ENV[descriptorKind(stt) ?? ""] ?? ASSEMBLYAI_API_KEY_ENV, env);
}

/** Resolve the agent-env API key for a TTS descriptor by its kind. */
export function resolveTtsApiKey(
  tts: TtsProvider | TtsOpener | undefined,
  env: Record<string, string>,
): string {
  return resolveApiKey(TTS_API_KEY_ENV[descriptorKind(tts) ?? ""] ?? CARTESIA_API_KEY_ENV, env);
}

/**
 * Resolve a provider value that may already be an instance (opener /
 * LanguageModel — a test escape hatch) rather than a descriptor. STT/TTS
 * openers are identified by the `open` method, `LanguageModel` by its
 * `specificationVersion` field — both absent on descriptors.
 */
export function resolveSttIfDescriptor(value: SttProvider | SttOpener): SttOpener {
  return "open" in value ? value : resolveStt(value);
}

export function resolveTtsIfDescriptor(value: TtsProvider | TtsOpener): TtsOpener {
  return "open" in value ? value : resolveTts(value);
}

export function resolveLlmIfDescriptor(
  value: LlmProvider | LanguageModel,
  env: Record<string, string>,
): LanguageModel {
  if (typeof value === "string") return value;
  return "specificationVersion" in value ? value : resolveLlm(value, env);
}
