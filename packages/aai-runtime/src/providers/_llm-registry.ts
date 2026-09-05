// Copyright 2026 the AAI authors. MIT license.
/**
 * The LLM provider registry — kind → credential env var, label, and the
 * `@ai-sdk/*` factory that builds the `LanguageModel`.
 *
 * Split out of `resolve.ts` so that file stays under the repo's line cap.
 *
 * Every `@ai-sdk/*` package here loads on FIRST USE, not at module load —
 * `lazyModel` (see `_lazy-model.ts`) is the LLM counterpart of `resolve.ts`'s
 * `lazyOpener`, and its module doc carries the measurement and why the
 * deferral is a wrapper rather than an async `create`. The entries below name
 * their vendor package in exactly one place each, the `import()` inside
 * `create`, so what a kind costs is still readable in one module.
 *
 * `resolve.ts` owns the lookup, the `apiKeyEnv` override, and
 * `registerLlmKind` (which mutates {@link LLM_REGISTRY} in place).
 */

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
import { type DeferredModel, lazyModel } from "./_lazy-model.ts";
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

/**
 * `@ai-sdk/openai`'s factory, imported once for the three kinds that use it —
 * OpenAI itself, OpenRouter, and the AssemblyAI gateway, both of which are
 * OpenAI-compatible chat endpoints. The dynamic `import()` is memoized by the
 * module system, so the three share one load.
 */
async function openAiFactory(): Promise<typeof import("@ai-sdk/openai")["createOpenAI"]> {
  return (await import("@ai-sdk/openai")).createOpenAI;
}

/**
 * The vendor provider ids, copied from what each `@ai-sdk/*` factory reports.
 *
 * A deferred model has to answer `provider` before its package is loaded (see
 * `_lazy-model.ts`), so these are the one thing here that can drift silently.
 * `_lazy-model.test.ts` asserts each against the eagerly-constructed model.
 */
const PROVIDER_IDS = {
  anthropic: "anthropic.messages",
  openai: "openai.responses",
  google: "google.generative-ai",
  mistral: "mistral.chat",
  xai: "xai.responses",
  groq: "groq.chat",
  openrouter: "openrouter.chat",
  gateway: "gateway",
  assemblyai: "assemblyai.chat",
} as const;

export const LLM_REGISTRY: Record<string, LlmRegistryEntry> = {
  [ANTHROPIC_KIND]: {
    envVar: ANTHROPIC_API_KEY_ENV,
    label: "Anthropic",
    create: (apiKey, d) =>
      lazyModel(PROVIDER_IDS.anthropic, model(d), async () => {
        const { createAnthropic } = await import("@ai-sdk/anthropic");
        // Pass baseURL explicitly so the SDK's loadOptionalSetting returns
        // before reading process.env["ANTHROPIC_BASE_URL"]. Without this,
        // the Deno platform server needs --allow-env to start a session.
        return createAnthropic({ apiKey, baseURL: "https://api.anthropic.com/v1" })(
          model(d),
        ) as DeferredModel;
      }),
  },
  [OPENAI_KIND]: {
    envVar: OPENAI_API_KEY_ENV,
    label: "OpenAI",
    create: (apiKey, d) =>
      lazyModel(PROVIDER_IDS.openai, model(d), async () =>
        (await openAiFactory())({ apiKey })(model(d)),
      ),
  },
  [GOOGLE_KIND]: {
    envVar: GOOGLE_API_KEY_ENV,
    label: "Google",
    create: (apiKey, d) =>
      lazyModel(PROVIDER_IDS.google, model(d), async () => {
        const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
        return createGoogleGenerativeAI({ apiKey })(model(d)) as DeferredModel;
      }),
  },
  [MISTRAL_KIND]: {
    envVar: MISTRAL_API_KEY_ENV,
    label: "Mistral",
    create: (apiKey, d) =>
      lazyModel(PROVIDER_IDS.mistral, model(d), async () => {
        const { createMistral } = await import("@ai-sdk/mistral");
        return createMistral({ apiKey })(model(d)) as DeferredModel;
      }),
  },
  [XAI_KIND]: {
    envVar: XAI_API_KEY_ENV,
    label: "xAI",
    create: (apiKey, d) =>
      lazyModel(PROVIDER_IDS.xai, model(d), async () => {
        const { createXai } = await import("@ai-sdk/xai");
        return createXai({ apiKey })(model(d)) as DeferredModel;
      }),
  },
  [GROQ_KIND]: {
    envVar: GROQ_API_KEY_ENV,
    label: "Groq",
    create: (apiKey, d) =>
      lazyModel(PROVIDER_IDS.groq, model(d), async () => {
        const { createGroq } = await import("@ai-sdk/groq");
        return createGroq({ apiKey })(model(d)) as DeferredModel;
      }),
  },
  [OPENROUTER_KIND]: {
    envVar: OPENROUTER_API_KEY_ENV,
    label: "OpenRouter",
    // OpenRouter is an OpenAI-compatible chat-completions API, so it
    // reuses @ai-sdk/openai's chat client pointed at its base URL — the
    // same shape as the AssemblyAI LLM Gateway below. Model ids are
    // "creator/model" strings, e.g. "anthropic/claude-sonnet-4.5".
    create: (apiKey, d) =>
      lazyModel(PROVIDER_IDS.openrouter, model(d), async () =>
        (await openAiFactory())({
          apiKey,
          baseURL: OPENROUTER_BASE_URL,
          name: "openrouter",
        }).chat(model(d)),
      ),
  },
  [GATEWAY_KIND]: {
    envVar: GATEWAY_API_KEY_ENV,
    label: "Vercel AI Gateway",
    // `createGateway` ships inside the `ai` package (a regular dependency),
    // so gateway models need no extra @ai-sdk/* install — and no deferral
    // either: `ai` is on the runtime's import path regardless, so wrapping
    // this one would cost an await and save nothing.
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
      // A descriptor reaching the host with no model is either an older
      // bundle or a hand-built config; the factory's default is the right
      // answer for both, and better than a runtime 400 from the gateway.
      const modelId = opts.model ?? ASSEMBLYAI_LLM_DEFAULT_MODEL;
      // The gateway implements /chat/completions only, so use .chat() —
      // the provider's default callable targets OpenAI's Responses API.
      // `fetch` repairs the gateway's id-less streaming tool_call deltas,
      // which the SDK's streaming tracker would otherwise reject.
      const chat = lazyModel(PROVIDER_IDS.assemblyai, modelId, async () =>
        (await openAiFactory())({
          apiKey,
          baseURL,
          name: "assemblyai",
          fetch: repairOpenAiStream(),
        }).chat(modelId),
      );
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
