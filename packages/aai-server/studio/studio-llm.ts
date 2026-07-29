// Copyright 2026 the AAI authors. MIT license.
/**
 * Studio chat LLM selection.
 *
 * The provider is chosen entirely from **platform-owned host configuration**
 * (never tenant env) via the SDK's own provider descriptors + `resolveLlm`,
 * so the studio can run on any pipeline-mode LLM provider. A chat request may
 * pick a *model* — but only from `studioLlmModels()`, the host-configured
 * provider's own known-model list (region-filtered for the gateway), all of
 * which run on the one host-held key for that provider. A client can never
 * name a provider, never supplies a key, and an unknown model is rejected
 * before anything streams.
 *
 * Defaults: the AssemblyAI LLM Gateway when `ASSEMBLYAI_API_KEY` is set,
 * else Anthropic direct (`ANTHROPIC_API_KEY`). `STUDIO_LLM_PROVIDER` /
 * `STUDIO_LLM_MODEL` override, and `STUDIO_LLM_REGION=eu` picks the
 * gateway's EU endpoint.
 */

import type { LlmProvider } from "@alexkroman1/aai/llm";
import {
  ANTHROPIC_API_KEY_ENV,
  ASSEMBLYAI_LLM_API_KEY_ENV,
  anthropic,
  assemblyAI,
  GATEWAY_API_KEY_ENV,
  GOOGLE_API_KEY_ENV,
  GROQ_API_KEY_ENV,
  gateway,
  google,
  groq,
  MISTRAL_API_KEY_ENV,
  mistral,
  OPENAI_API_KEY_ENV,
  openai,
  XAI_API_KEY_ENV,
  xai,
} from "@alexkroman1/aai/llm";
import { resolveLlm } from "@alexkroman1/aai/runtime";
import type { LanguageModel } from "ai";

type StudioLlmEntry = {
  envVar: string;
  /**
   * Known models, most capable first. The first entry is the default when
   * `STUDIO_LLM_MODEL` is unset; an empty list means this provider requires
   * an explicit `STUDIO_LLM_MODEL`. Takes env because gateway availability
   * is region-dependent.
   */
  models: (env: NodeJS.ProcessEnv) => readonly string[];
  make: (model: string, env: NodeJS.ProcessEnv) => LlmProvider;
};

/**
 * Models on the AssemblyAI LLM Gateway, per
 * https://www.assemblyai.com/docs/llm-gateway/available-models.
 *
 * Order matters: the first entry available in the configured region is the
 * default. `gpt-5.5` leads because OpenAI models are the only ones the
 * gateway documents streamed responses for. Claude and Gemini do stream,
 * but only once their id-less `tool_calls` deltas are repaired
 * (`_openai-stream-repair.ts` in the SDK), so they are a step off the
 * supported path.
 */
export const ASSEMBLYAI_GATEWAY_MODELS = [
  "gpt-5.5",
  // Leads the EU list — the OpenAI models are US-only.
  "claude-sonnet-4-6",
  "gpt-5.2",
  "gpt-5.1",
  "gpt-5",
  "gpt-5-mini",
  "gpt-5-nano",
  "gpt-4.1",
  "gpt-oss-120b",
  "gpt-oss-20b",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-opus-4-5-20251101",
  "claude-sonnet-4-5-20250929",
  "claude-haiku-4-5-20251001",
  "gemini-3.5-flash",
  "gemini-3.1-flash-lite-preview",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "qwen3-next-80b-a3b",
  "qwen3-32B",
  "kimi-k2.5",
] as const;

/**
 * Gateway models the EU endpoint does not serve. Per the docs only Anthropic
 * Claude and most Gemini models are available in the EU; OpenAI is US-only,
 * as is Gemini 3.1 Flash Lite Preview. Qwen/Kimi are undocumented for the EU
 * and excluded conservatively — hiding a model is harmless, offering one
 * that 404s is not.
 */
const GATEWAY_US_ONLY_MODELS: ReadonlySet<string> = new Set(
  ASSEMBLYAI_GATEWAY_MODELS.filter(
    (model) =>
      model.startsWith("gpt-") ||
      model.startsWith("qwen") ||
      model.startsWith("kimi") ||
      model === "gemini-3.1-flash-lite-preview",
  ),
);

const ASSEMBLYAI_GATEWAY_EU_MODELS = ASSEMBLYAI_GATEWAY_MODELS.filter(
  (model) => !GATEWAY_US_ONLY_MODELS.has(model),
);

function isEuGateway(env: NodeJS.ProcessEnv): boolean {
  return env.STUDIO_LLM_REGION === "eu";
}

/** Anthropic direct — the current Claude 5 family plus Haiku 4.5. */
const ANTHROPIC_MODELS = [
  "claude-sonnet-5",
  "claude-opus-5",
  "claude-fable-5",
  "claude-haiku-4-5-20251001",
] as const;

/**
 * Providers the studio chat can run on. All pipeline-mode LLM providers are
 * wired so `STUDIO_LLM_PROVIDER` reaches any of them; the two the platform
 * is expected to hold keys for carry known-model lists so they work without
 * an explicit `STUDIO_LLM_MODEL`.
 */
const STUDIO_LLM_PROVIDERS: Record<string, StudioLlmEntry> = {
  assemblyai: {
    envVar: ASSEMBLYAI_LLM_API_KEY_ENV,
    models: (env) => (isEuGateway(env) ? ASSEMBLYAI_GATEWAY_EU_MODELS : ASSEMBLYAI_GATEWAY_MODELS),
    make: (model, env) =>
      assemblyAI({ model, ...(isEuGateway(env) ? { region: "eu" as const } : {}) }),
  },
  anthropic: {
    envVar: ANTHROPIC_API_KEY_ENV,
    models: () => ANTHROPIC_MODELS,
    make: (model) => anthropic({ model }),
  },
  openai: {
    envVar: OPENAI_API_KEY_ENV,
    models: () => [],
    make: (model) => openai({ model }),
  },
  google: {
    envVar: GOOGLE_API_KEY_ENV,
    models: () => [],
    make: (model) => google({ model }),
  },
  mistral: {
    envVar: MISTRAL_API_KEY_ENV,
    models: () => [],
    make: (model) => mistral({ model }),
  },
  xai: { envVar: XAI_API_KEY_ENV, models: () => [], make: (model) => xai({ model }) },
  groq: {
    envVar: GROQ_API_KEY_ENV,
    models: () => [],
    make: (model) => groq({ model }),
  },
  gateway: {
    envVar: GATEWAY_API_KEY_ENV,
    models: () => [],
    make: (model) => gateway({ model }),
  },
};

/** Providers auto-selected (in order) when STUDIO_LLM_PROVIDER is unset. */
const AUTO_PROVIDER_ORDER = ["assemblyai", "anthropic"] as const;

export type StudioLlmSelection = {
  provider: string;
  model: string;
  descriptor: LlmProvider;
  envVar: string;
};

/**
 * The host-configured provider/model, or null when no key selects one.
 *
 * `modelOverride` is the per-request selection (the studio's model picker).
 * It never changes the provider — only which of that provider's known models
 * runs the turn — and must be on `studioLlmModels()` or this throws. Callers
 * exposing it to a request should pre-validate and 400 instead.
 */
export function selectStudioLlm(
  env: NodeJS.ProcessEnv = process.env,
  modelOverride?: string,
): StudioLlmSelection | null {
  const explicit = env.STUDIO_LLM_PROVIDER?.toLowerCase();
  let provider: string | undefined;
  if (explicit) {
    if (!(explicit in STUDIO_LLM_PROVIDERS)) {
      throw new Error(
        `Unknown STUDIO_LLM_PROVIDER "${explicit}" — one of: ${Object.keys(STUDIO_LLM_PROVIDERS).join(", ")}`,
      );
    }
    provider = explicit;
  } else {
    provider = AUTO_PROVIDER_ORDER.find((name) => {
      const candidate = STUDIO_LLM_PROVIDERS[name];
      return candidate !== undefined && Boolean(env[candidate.envVar]);
    });
  }
  if (!provider) return null;
  // Guarded above for the explicit path; AUTO_PROVIDER_ORDER names are keys.
  const entry = STUDIO_LLM_PROVIDERS[provider] as StudioLlmEntry;
  // `||` not `??`: an empty-string env var means "unset".
  const defaultModel = env.STUDIO_LLM_MODEL || entry.models(env)[0];
  if (!defaultModel) {
    throw new Error(`STUDIO_LLM_MODEL is required for STUDIO_LLM_PROVIDER "${provider}"`);
  }
  let model = defaultModel;
  if (modelOverride !== undefined && modelOverride !== defaultModel) {
    // Validated against the provider's *own* list, not just "non-empty": the
    // override is request-supplied, and this is what keeps the chat route
    // from becoming an arbitrary-model proxy on the host's key.
    if (!entry.models(env).includes(modelOverride)) {
      throw new Error(`Model "${modelOverride}" is not available on provider "${provider}"`);
    }
    model = modelOverride;
  }
  return { provider, model, descriptor: entry.make(model, env), envVar: entry.envVar };
}

/**
 * Models a chat request may switch between: the host-configured default plus
 * the configured provider's known models (region-filtered for the gateway).
 * Empty when the studio LLM is unconfigured. Every entry runs on the same
 * host-held key, so offering the list grants nothing a request didn't
 * already have — except the choice.
 */
export function studioLlmModels(env: NodeJS.ProcessEnv = process.env): string[] {
  let selection: StudioLlmSelection | null;
  try {
    selection = selectStudioLlm(env);
  } catch {
    return [];
  }
  if (!(selection && env[selection.envVar])) return [];
  const entry = STUDIO_LLM_PROVIDERS[selection.provider] as StudioLlmEntry;
  // The default leads (it may be an explicit STUDIO_LLM_MODEL outside the
  // curated list); Set dedupes when it is the list's own head.
  return [...new Set([selection.model, ...entry.models(env)])];
}

/** True when the platform host is configured to run the studio LLM. */
export function isStudioLlmConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const selection = selectStudioLlm(env);
    return selection !== null && Boolean(env[selection.envVar]);
  } catch {
    return false;
  }
}

/**
 * Provider/model info for the status endpoint; null when unconfigured.
 * `models` is the switchable list (`studioLlmModels`) — the client's model
 * picker renders exactly this, so it can never offer a model the chat route
 * would refuse.
 */
export function studioLlmInfo(
  env: NodeJS.ProcessEnv = process.env,
): { provider: string; model: string; models: string[] } | null {
  if (!isStudioLlmConfigured(env)) return null;
  // isStudioLlmConfigured just proved this select succeeds and is non-null.
  const selection = selectStudioLlm(env) as StudioLlmSelection;
  return { provider: selection.provider, model: selection.model, models: studioLlmModels(env) };
}

/**
 * Resolve the host-configured selection to a live `LanguageModel`.
 * `modelOverride` (the chat request's picker choice) must be on
 * `studioLlmModels(env)` — see `selectStudioLlm`.
 */
export function studioModel(
  env: NodeJS.ProcessEnv = process.env,
  modelOverride?: string,
): LanguageModel {
  const selection = selectStudioLlm(env, modelOverride);
  if (!selection) {
    throw new Error(
      "Studio LLM not configured: set ASSEMBLYAI_API_KEY (LLM Gateway) or " +
        "ANTHROPIC_API_KEY, or choose a provider with STUDIO_LLM_PROVIDER",
    );
  }
  const key = env[selection.envVar];
  if (!key) {
    throw new Error(`Studio LLM misconfigured: ${selection.envVar} is not set`);
  }
  // resolveLlm reads the key from the env record it is given — pass exactly
  // the one variable it needs (host env never flows anywhere else).
  return resolveLlm(selection.descriptor, { [selection.envVar]: key });
}
