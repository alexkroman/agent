// Copyright 2026 the AAI authors. MIT license.
/**
 * The LLM provider registry — provider name → credential env var, label,
 * endpoint, and the `@ai-sdk/*` factory that builds the `LanguageModel`.
 *
 * Split out of `resolve.ts` so that file stays under the repo's line cap.
 *
 * **This table is where each provider's key variable and base URL LIVE.** The
 * SDK's `llm({ provider, model, baseUrl?, apiKeyEnv?, providerOptions? })` is
 * one descriptor for every vendor, and publishes neither: an author never
 * types one, and a second copy of an endpoint in the SDK is a second place for
 * it to go stale. The one exception is the AssemblyAI gateway, whose endpoints
 * are on `@alexkroman1/aai/host-internal` because `stepGenerate` dials it from
 * inside a workflow step, with no resolver in reach.
 *
 * Every `@ai-sdk/*` package here loads on FIRST USE, not at module load —
 * `lazyModel` (see `_lazy-model.ts`) is the LLM counterpart of `resolve.ts`'s
 * `lazyOpener`, and its module doc carries the measurement and why the
 * deferral is a wrapper rather than an async `create`. The entries below name
 * their vendor package in exactly one place each, the `import()` inside
 * `create`, so what a provider costs is still readable in one module.
 *
 * A provider NAME with no entry here is not an error by itself — the name is
 * open in the SDK's type. {@link llmEntryFor} answers an OpenAI-compatible
 * entry for a descriptor that carries a `baseUrl`, which is how a vendor this
 * release has not heard of is reached without a registration.
 *
 * `resolve.ts` owns the lookup, the `apiKeyEnv` override, and
 * `registerLlmKind` (which mutates {@link LLM_REGISTRY} in place).
 */

import { omitUndefined } from "@alexkroman1/aai";
import {
  ASSEMBLYAI_LLM_API_KEY_ENV,
  ASSEMBLYAI_LLM_GATEWAY_EU_URL,
  ASSEMBLYAI_LLM_GATEWAY_URL,
  ASSEMBLYAI_LLM_KIND,
} from "@alexkroman1/aai/host-internal";
import {
  ASSEMBLYAI_LLM_DEFAULT_MODEL,
  type AssemblyAILlmProviderOptions,
  type KnownLlmProvider,
  type LlmProvider,
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

/** One registry entry per LLM provider — adding a provider is one entry here. */
export type LlmRegistryEntry = {
  readonly envVar: string;
  readonly label: string;
  readonly create: (apiKey: string, descriptor: LlmProvider) => LanguageModel;
};

/** The AI SDK's `providerOptions` setting, as `defaultSettingsMiddleware` types it. */
type ProviderOptionsSetting = NonNullable<
  Parameters<typeof defaultSettingsMiddleware>[0]["settings"]["providerOptions"]
>;

/** What an `llm()` descriptor's options carry, as the resolver reads them. */
type LlmDescriptorOptions = {
  model: string;
  baseUrl?: string;
  providerOptions?: Record<string, unknown>;
};

function opts(descriptor: LlmProvider): LlmDescriptorOptions {
  return options<LlmDescriptorOptions>(descriptor);
}

function model(descriptor: LlmProvider): string {
  return opts(descriptor).model;
}

/**
 * The descriptor's `providerOptions`, layered onto every call as the AI SDK's
 * `providerOptions[key]` — the one generic channel for a vendor-specific
 * setting, so the SDK needs no per-vendor options type to carry one. Absent,
 * the model is returned unwrapped (by identity).
 */
function withProviderOptions(
  lm: LanguageModel,
  key: string,
  descriptor: LlmProvider,
): LanguageModel {
  const providerOptions = opts(descriptor).providerOptions;
  if (providerOptions === undefined || typeof lm === "string") return lm;
  return wrapLanguageModel({
    model: lm,
    middleware: defaultSettingsMiddleware({
      settings: { providerOptions: { [key]: providerOptions } as ProviderOptionsSetting },
    }),
  });
}

/**
 * `@ai-sdk/openai`'s factory, imported once for every kind that uses it —
 * OpenAI itself, and the OpenAI-compatible chat endpoints (OpenRouter,
 * Cerebras, the AssemblyAI gateway, and any `baseUrl` provider). The dynamic
 * `import()` is memoized by the module system, so they share one load.
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
  gateway: "gateway",
  assemblyai: "assemblyai.chat",
} as const;

/**
 * An OpenAI-compatible chat-completions provider at `baseURL` — the shape of
 * OpenRouter, Cerebras and any `baseUrl` descriptor. Uses `.chat()`, because
 * the provider's default callable targets OpenAI's Responses API, which none
 * of them serve.
 */
function openAiCompatible(
  name: string,
  envVar: string,
  label: string,
  defaultBaseUrl: string | undefined,
): LlmRegistryEntry {
  return {
    envVar,
    label,
    create: (apiKey, d) => {
      const baseURL = opts(d).baseUrl ?? defaultBaseUrl;
      return withProviderOptions(
        lazyModel(`${name}.chat`, model(d), async () =>
          (await openAiFactory())({ apiKey, ...omitUndefined({ baseURL }), name }).chat(model(d)),
        ),
        "openai",
        d,
      );
    },
  };
}

export const LLM_REGISTRY: Record<string, LlmRegistryEntry> = {
  anthropic: {
    envVar: "ANTHROPIC_API_KEY",
    label: "Anthropic",
    create: (apiKey, d) =>
      withProviderOptions(
        lazyModel(PROVIDER_IDS.anthropic, model(d), async () => {
          const { createAnthropic } = await import("@ai-sdk/anthropic");
          // Pass baseURL explicitly so the SDK's loadOptionalSetting returns
          // before reading process.env["ANTHROPIC_BASE_URL"]. Without this,
          // the Deno platform server needs --allow-env to start a session.
          return createAnthropic({
            apiKey,
            baseURL: opts(d).baseUrl ?? "https://api.anthropic.com/v1",
          })(model(d)) as DeferredModel;
        }),
        "anthropic",
        d,
      ),
  },
  openai: {
    envVar: "OPENAI_API_KEY",
    label: "OpenAI",
    create: (apiKey, d) => {
      const baseURL = opts(d).baseUrl;
      return withProviderOptions(
        lazyModel(PROVIDER_IDS.openai, model(d), async () =>
          (await openAiFactory())({ apiKey, ...omitUndefined({ baseURL }) })(model(d)),
        ),
        "openai",
        d,
      );
    },
  },
  google: {
    envVar: "GOOGLE_GENERATIVE_AI_API_KEY",
    label: "Google",
    create: (apiKey, d) => {
      const baseURL = opts(d).baseUrl;
      return withProviderOptions(
        lazyModel(PROVIDER_IDS.google, model(d), async () => {
          const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
          return createGoogleGenerativeAI({ apiKey, ...omitUndefined({ baseURL }) })(
            model(d),
          ) as DeferredModel;
        }),
        "google",
        d,
      );
    },
  },
  mistral: {
    envVar: "MISTRAL_API_KEY",
    label: "Mistral",
    create: (apiKey, d) => {
      const baseURL = opts(d).baseUrl;
      return withProviderOptions(
        lazyModel(PROVIDER_IDS.mistral, model(d), async () => {
          const { createMistral } = await import("@ai-sdk/mistral");
          return createMistral({ apiKey, ...omitUndefined({ baseURL }) })(
            model(d),
          ) as DeferredModel;
        }),
        "mistral",
        d,
      );
    },
  },
  xai: {
    envVar: "XAI_API_KEY",
    label: "xAI",
    create: (apiKey, d) => {
      const baseURL = opts(d).baseUrl;
      return withProviderOptions(
        lazyModel(PROVIDER_IDS.xai, model(d), async () => {
          const { createXai } = await import("@ai-sdk/xai");
          return createXai({ apiKey, ...omitUndefined({ baseURL }) })(model(d)) as DeferredModel;
        }),
        "xai",
        d,
      );
    },
  },
  groq: {
    envVar: "GROQ_API_KEY",
    label: "Groq",
    create: (apiKey, d) => {
      const baseURL = opts(d).baseUrl;
      return withProviderOptions(
        lazyModel(PROVIDER_IDS.groq, model(d), async () => {
          const { createGroq } = await import("@ai-sdk/groq");
          return createGroq({ apiKey, ...omitUndefined({ baseURL }) })(model(d)) as DeferredModel;
        }),
        "groq",
        d,
      );
    },
  },
  // OpenRouter and Cerebras are OpenAI-compatible chat-completions APIs, so
  // both reuse @ai-sdk/openai's chat client pointed at their base URL — no
  // extra @ai-sdk/* install. OpenRouter ids are "creator/model"; Cerebras ids
  // are bare names.
  openrouter: openAiCompatible(
    "openrouter",
    "OPENROUTER_API_KEY",
    "OpenRouter",
    "https://openrouter.ai/api/v1",
  ),
  cerebras: openAiCompatible(
    "cerebras",
    "CEREBRAS_API_KEY",
    "Cerebras",
    "https://api.cerebras.ai/v1",
  ),
  gateway: {
    envVar: "AI_GATEWAY_API_KEY",
    label: "Vercel AI Gateway",
    // `createGateway` ships inside the `ai` package (a regular dependency),
    // so gateway models need no extra @ai-sdk/* install — and no deferral
    // either: `ai` is on the runtime's import path regardless, so wrapping
    // this one would cost an await and save nothing.
    create: (apiKey, d) => {
      const baseURL = opts(d).baseUrl;
      return withProviderOptions(
        createGateway({ apiKey, ...omitUndefined({ baseURL }) })(model(d)),
        "gateway",
        d,
      );
    },
  },
  [ASSEMBLYAI_LLM_KIND]: {
    envVar: ASSEMBLYAI_LLM_API_KEY_ENV,
    label: "AssemblyAI",
    create: (apiKey, d) => {
      const { baseUrl } = opts(d);
      const own = (opts(d).providerOptions ?? {}) as AssemblyAILlmProviderOptions;
      // An explicit baseUrl WINS over `region` — the rule `pickEndpoint`
      // owns, shared with the STT opener's `streamingUrl`. Unlike that one this
      // stage has a US default of its own to fall back to.
      const baseURL = pickEndpoint(baseUrl, own.region, {
        eu: ASSEMBLYAI_LLM_GATEWAY_EU_URL,
        default: ASSEMBLYAI_LLM_GATEWAY_URL,
      });
      // A descriptor reaching the host with no model is either an older
      // bundle or a hand-built config; the SDK's default is the right answer
      // for both, and better than a runtime 400 from the gateway.
      const modelId = model(d) ?? ASSEMBLYAI_LLM_DEFAULT_MODEL;
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
      // own server-side reasoning default. `region` and `reasoningEffort` are
      // CONSUMED here, so AssemblyAI's providerOptions are not forwarded.
      const middleware: LanguageModelMiddleware[] = [gatewayToolSchemaMiddleware()];
      const reasoningEffort = own.reasoningEffort;
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
} satisfies Record<KnownLlmProvider, LlmRegistryEntry>;

/**
 * The env var an unregistered provider's key is read from when its descriptor
 * names none: `<PROVIDER>_API_KEY`, upper-cased with every other character an
 * underscore — `"together-ai"` reads `TOGETHER_AI_API_KEY`.
 */
export function compatibleEnvVar(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
}

/**
 * The entry that resolves `descriptor`: its registered one, else — for an
 * unregistered provider whose descriptor carries a `baseUrl` — an
 * OpenAI-compatible chat entry at that URL. `undefined` means nothing can
 * resolve it, which `resolveLlm` reports naming what is supported.
 */
export function llmEntryFor(descriptor: LlmProvider): LlmRegistryEntry | undefined {
  const registered = LLM_REGISTRY[descriptor.kind];
  if (registered !== undefined) return registered;
  const baseUrl = (descriptor.options as { baseUrl?: unknown } | undefined)?.baseUrl;
  if (typeof baseUrl !== "string" || baseUrl === "") return undefined;
  return openAiCompatible(
    descriptor.kind,
    compatibleEnvVar(descriptor.kind),
    `${descriptor.kind} (OpenAI-compatible)`,
    baseUrl,
  );
}
