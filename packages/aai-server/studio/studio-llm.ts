// Copyright 2026 the AAI authors. MIT license.
/**
 * Studio chat LLM selection.
 *
 * The model is chosen from **platform-owned host configuration** (never
 * tenant env) via the SDK's own provider descriptors + `resolveLlm`, so the
 * studio can run on any pipeline-mode LLM provider. Host env sets the
 * default; the browser may override it per request, but only within
 * `studioLlmOptions()` — the providers whose key the host actually holds and
 * the models curated for them. A client can never name an arbitrary
 * provider/model and can never supply a key.
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
  /** Human-readable group label for the model picker. */
  label: string;
  /**
   * Models offered in the picker, most capable first. The first entry is the
   * default when `STUDIO_LLM_MODEL` is unset; an empty list means this
   * provider is env-only (it requires an explicit `STUDIO_LLM_MODEL` and is
   * offered in the picker only while it is the host-selected default).
   * Takes env because gateway availability is region-dependent.
   */
  models: (env: NodeJS.ProcessEnv) => readonly string[];
  make: (model: string, env: NodeJS.ProcessEnv) => LlmProvider;
};

/**
 * Models on the AssemblyAI LLM Gateway, per
 * https://www.assemblyai.com/docs/llm-gateway/available-models.
 *
 * Order matters: the first entry available in the configured region is the
 * default. `gpt-5.2` leads because OpenAI models are the only ones the
 * gateway documents streamed responses for — and it is the fastest of them
 * at a comparable LMArena score. Claude and Gemini do stream, but only once
 * their id-less `tool_calls` deltas are repaired (`_openai-stream-repair.ts`
 * in the SDK), so they are a step off the supported path.
 */
const ASSEMBLYAI_GATEWAY_MODELS = [
  "gpt-5.2",
  // Leads the EU list — the OpenAI models above are US-only.
  "claude-sonnet-4-6",
  "gpt-5.5",
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
 * is expected to hold keys for carry curated model lists for the picker.
 */
const STUDIO_LLM_PROVIDERS: Record<string, StudioLlmEntry> = {
  assemblyai: {
    envVar: ASSEMBLYAI_LLM_API_KEY_ENV,
    label: "AssemblyAI LLM Gateway",
    models: (env) => (isEuGateway(env) ? ASSEMBLYAI_GATEWAY_EU_MODELS : ASSEMBLYAI_GATEWAY_MODELS),
    make: (model, env) =>
      assemblyAI({ model, ...(isEuGateway(env) ? { region: "eu" as const } : {}) }),
  },
  anthropic: {
    envVar: ANTHROPIC_API_KEY_ENV,
    label: "Anthropic",
    models: () => ANTHROPIC_MODELS,
    make: (model) => anthropic({ model }),
  },
  openai: {
    envVar: OPENAI_API_KEY_ENV,
    label: "OpenAI",
    models: () => [],
    make: (model) => openai({ model }),
  },
  google: {
    envVar: GOOGLE_API_KEY_ENV,
    label: "Google",
    models: () => [],
    make: (model) => google({ model }),
  },
  mistral: {
    envVar: MISTRAL_API_KEY_ENV,
    label: "Mistral",
    models: () => [],
    make: (model) => mistral({ model }),
  },
  xai: { envVar: XAI_API_KEY_ENV, label: "xAI", models: () => [], make: (model) => xai({ model }) },
  groq: {
    envVar: GROQ_API_KEY_ENV,
    label: "Groq",
    models: () => [],
    make: (model) => groq({ model }),
  },
  gateway: {
    envVar: GATEWAY_API_KEY_ENV,
    label: "Vercel AI Gateway",
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

/** A provider the browser may pick, with the models it may pick from. */
export type StudioLlmOption = {
  provider: string;
  label: string;
  models: string[];
};

export type StudioLlmOptions = {
  /** The host-configured default; null when no provider is configured. */
  default: { provider: string; model: string } | null;
  providers: StudioLlmOption[];
};

function entryFor(provider: string): StudioLlmEntry | undefined {
  return STUDIO_LLM_PROVIDERS[provider];
}

/**
 * Pick the studio chat LLM from host env. Explicit `STUDIO_LLM_PROVIDER`
 * wins; otherwise the AssemblyAI LLM Gateway when its key is present, then
 * Anthropic. Returns null when nothing is configured. Throws on a
 * misconfiguration worth surfacing (unknown provider, missing model).
 */
export function selectStudioLlm(env: NodeJS.ProcessEnv = process.env): StudioLlmSelection | null {
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
  const model = env.STUDIO_LLM_MODEL || entry.models(env)[0];
  if (!model) {
    throw new Error(`STUDIO_LLM_MODEL is required for STUDIO_LLM_PROVIDER "${provider}"`);
  }
  return { provider, model, descriptor: entry.make(model, env), envVar: entry.envVar };
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

/** Provider/model info for the status endpoint; null when unconfigured. */
export function studioLlmInfo(
  env: NodeJS.ProcessEnv = process.env,
): { provider: string; model: string } | null {
  if (!isStudioLlmConfigured(env)) return null;
  // isStudioLlmConfigured just proved this select succeeds and is non-null.
  const selection = selectStudioLlm(env) as StudioLlmSelection;
  return { provider: selection.provider, model: selection.model };
}

/**
 * Everything the browser is allowed to choose between: providers whose key
 * the host holds and that have curated models, plus the host-selected
 * default (so an env-only provider still shows the model it is running).
 */
export function studioLlmOptions(env: NodeJS.ProcessEnv = process.env): StudioLlmOptions {
  const active = isStudioLlmConfigured(env) ? selectStudioLlm(env) : null;
  const providers: StudioLlmOption[] = [];
  for (const [provider, entry] of Object.entries(STUDIO_LLM_PROVIDERS)) {
    if (!env[entry.envVar]) continue;
    const models = [...entry.models(env)];
    // An env-only provider contributes just the model it was told to run.
    if (active?.provider === provider && !models.includes(active.model)) {
      models.unshift(active.model);
    }
    if (models.length > 0) providers.push({ provider, label: entry.label, models });
  }
  return {
    default: active ? { provider: active.provider, model: active.model } : null,
    providers,
  };
}

/**
 * Validate a browser-supplied provider/model against `studioLlmOptions` and
 * build the selection. Returns null when the request names something the
 * host cannot or may not run, so callers can answer 400 rather than
 * constructing a model from unvalidated input.
 */
export function resolveStudioSelection(
  requested: { provider?: string | undefined; model?: string | undefined },
  env: NodeJS.ProcessEnv = process.env,
): StudioLlmSelection | null {
  const { provider, model } = requested;
  if (!(provider && model)) return null;
  const offered = studioLlmOptions(env).providers.find((p) => p.provider === provider);
  if (!offered?.models.includes(model)) return null;
  const entry = entryFor(provider);
  if (!entry) return null;
  return { provider, model, descriptor: entry.make(model, env), envVar: entry.envVar };
}

/**
 * Resolve the studio chat model. With no `requested` override this is the
 * host-env default. Throws when unconfigured, or when an override names a
 * provider/model outside `studioLlmOptions`.
 */
export function studioModel(
  requested: { provider?: string | undefined; model?: string | undefined } = {},
  env: NodeJS.ProcessEnv = process.env,
): LanguageModel {
  const selection =
    requested.provider || requested.model
      ? resolveStudioSelection(requested, env)
      : selectStudioLlm(env);
  if (!selection) {
    if (requested.provider || requested.model) {
      throw new Error(
        `Studio LLM "${requested.provider}/${requested.model}" is not available on this server`,
      );
    }
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
