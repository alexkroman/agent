// Copyright 2026 the AAI authors. MIT license.
/**
 * The LLM provider registry — kind → credential env var, label, and the
 * `@ai-sdk/*` factory that builds the `LanguageModel`.
 *
 * Split out of `resolve.ts` so that file stays under the repo's line cap.
 * The split falls here rather than anywhere else because this is the only
 * part of provider resolution that imports vendor SDKs EAGERLY: STT and TTS
 * openers load theirs behind `lazyOpener`, while every `@ai-sdk/*` package
 * is pulled in at module load by the entries below. Keeping them in one
 * module makes that cost visible in one place.
 *
 * `resolve.ts` owns the lookup, the `apiKeyEnv` override, and
 * `registerLlmKind` (which mutates {@link LLM_REGISTRY} in place).
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { createMistral } from "@ai-sdk/mistral";
import { createOpenAI } from "@ai-sdk/openai";
import { createXai } from "@ai-sdk/xai";
import {
  ANTHROPIC_API_KEY_ENV,
  ANTHROPIC_KIND,
  ASSEMBLYAI_LLM_API_KEY_ENV,
  ASSEMBLYAI_LLM_KIND,
  GATEWAY_API_KEY_ENV,
  GATEWAY_KIND,
  GOOGLE_API_KEY_ENV,
  GOOGLE_KIND,
  GROQ_API_KEY_ENV,
  GROQ_KIND,
  MISTRAL_API_KEY_ENV,
  MISTRAL_KIND,
  OPENAI_API_KEY_ENV,
  OPENAI_KIND,
  OPENROUTER_API_KEY_ENV,
  OPENROUTER_KIND,
  XAI_API_KEY_ENV,
  XAI_KIND,
} from "@alexkroman1/aai/host-internal";
import type { LlmProvider } from "@alexkroman1/aai/llm";
import {
  ASSEMBLYAI_LLM_DEFAULT_MODEL,
  ASSEMBLYAI_LLM_GATEWAY_EU_URL,
  ASSEMBLYAI_LLM_GATEWAY_URL,
  type AssemblyAILlmOptions,
  OPENROUTER_BASE_URL,
} from "@alexkroman1/aai/llm";
import {
  createGateway,
  defaultSettingsMiddleware,
  type LanguageModel,
  type LanguageModelMiddleware,
  wrapLanguageModel,
} from "ai";
import { gatewayToolSchemaMiddleware } from "./_gateway-tool-schema.ts";
import { repairOpenAiStream } from "./_openai-stream-repair.ts";
import { options, pickEndpoint } from "./_utils.ts";

/** One registry entry per LLM provider kind — adding a provider is one entry here. */
export type LlmRegistryEntry = {
  readonly envVar: string;
  readonly label: string;
  readonly create: (apiKey: string, descriptor: LlmProvider) => LanguageModel;
};

function model(descriptor: LlmProvider): string {
  return options<{ model: string }>(descriptor).model;
}

export const LLM_REGISTRY: Record<string, LlmRegistryEntry> = {
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
  [OPENROUTER_KIND]: {
    envVar: OPENROUTER_API_KEY_ENV,
    label: "OpenRouter",
    // OpenRouter is an OpenAI-compatible chat-completions API, so it
    // reuses @ai-sdk/openai's chat client pointed at its base URL — the
    // same shape as the AssemblyAI LLM Gateway below. Model ids are
    // "creator/model" strings, e.g. "anthropic/claude-sonnet-4.5".
    create: (apiKey, d) =>
      createOpenAI({ apiKey, baseURL: OPENROUTER_BASE_URL, name: "openrouter" }).chat(model(d)),
  },
  [GATEWAY_KIND]: {
    envVar: GATEWAY_API_KEY_ENV,
    label: "Vercel AI Gateway",
    // `createGateway` ships inside the `ai` package (a regular dependency),
    // so gateway models need no extra @ai-sdk/* install. Model ids are
    // "creator/model" strings, e.g. "zai/glm-4.6".
    create: (apiKey, d) => createGateway({ apiKey })(model(d)),
  },
  [ASSEMBLYAI_LLM_KIND]: {
    envVar: ASSEMBLYAI_LLM_API_KEY_ENV,
    label: "AssemblyAI",
    create: (apiKey, d) => {
      const opts = options<AssemblyAILlmOptions>(d);
      // An explicit gatewayUrl WINS over `region` — the rule `pickEndpoint`
      // owns, shared with the STT opener's `streamingUrl`. Unlike that one this
      // stage has a US default of its own to fall back to.
      const baseURL = pickEndpoint(opts.gatewayUrl, opts.region, {
        eu: ASSEMBLYAI_LLM_GATEWAY_EU_URL,
        default: ASSEMBLYAI_LLM_GATEWAY_URL,
      });
      // The gateway implements /chat/completions only, so use .chat() —
      // the provider's default callable targets OpenAI's Responses API.
      // `fetch` repairs the gateway's id-less streaming tool_call deltas,
      // which the SDK's streaming tracker would otherwise reject.
      // A descriptor reaching the host with no model is either an older
      // bundle or a hand-built config; the factory's default is the right
      // answer for both, and better than a runtime 400 from the gateway.
      const modelId = opts.model ?? ASSEMBLYAI_LLM_DEFAULT_MODEL;
      const chat = createOpenAI({
        apiKey,
        baseURL,
        name: "assemblyai",
        fetch: repairOpenAiStream(),
      }).chat(modelId);
      // The tool-schema prune is UNCONDITIONAL — it is what makes the gateway's
      // Gemini path usable at all, and it is a no-op (by identity) for every
      // model that accepts standard JSON Schema. reasoning_effort is layered on
      // top only when the descriptor asks for one; unset, the model runs on its
      // own server-side reasoning default.
      const middleware: LanguageModelMiddleware[] = [gatewayToolSchemaMiddleware()];
      const reasoningEffort = opts.reasoningEffort;
      if (reasoningEffort !== undefined) {
        middleware.push(
          defaultSettingsMiddleware({
            settings: { providerOptions: { openai: { reasoningEffort } } },
          }),
        );
      }
      return wrapLanguageModel({ model: chat, middleware });
    },
  },
};
