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
import { createGateway, type LanguageModel } from "ai";
import { ANTHROPIC_API_KEY_ENV, ANTHROPIC_KIND } from "../../sdk/providers/llm/anthropic.ts";
import {
  ASSEMBLYAI_LLM_API_KEY_ENV,
  ASSEMBLYAI_LLM_GATEWAY_EU_URL,
  ASSEMBLYAI_LLM_GATEWAY_URL,
  ASSEMBLYAI_LLM_KIND,
  type AssemblyAILlmOptions,
} from "../../sdk/providers/llm/assemblyai.ts";
import { GATEWAY_API_KEY_ENV, GATEWAY_KIND } from "../../sdk/providers/llm/gateway.ts";
import { GOOGLE_API_KEY_ENV, GOOGLE_KIND } from "../../sdk/providers/llm/google.ts";
import { GROQ_API_KEY_ENV, GROQ_KIND } from "../../sdk/providers/llm/groq.ts";
import { MISTRAL_API_KEY_ENV, MISTRAL_KIND } from "../../sdk/providers/llm/mistral.ts";
import { OPENAI_API_KEY_ENV, OPENAI_KIND } from "../../sdk/providers/llm/openai.ts";
import { XAI_API_KEY_ENV, XAI_KIND } from "../../sdk/providers/llm/xai.ts";
import { OPENAI_REALTIME_KIND } from "../../sdk/providers/s2s/openai-realtime.ts";
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
import { requireApiKey } from "./_utils.ts";

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

/**
 * One registry entry per STT/TTS provider kind — the kind's env var and
 * opener factory live together, so adding a provider is one entry here and
 * an unmapped kind cannot silently resolve the wrong vendor's key.
 */
export type OpenerRegistryEntry<Opener> = {
  readonly envVar: string;
  readonly open: (descriptor: { options: Record<string, unknown> }) => Opener;
};

/**
 * Wrap a dynamically-imported opener so its vendor SDK loads on first `open()`
 * instead of at module load.
 *
 * `resolve.ts` is reachable from `host/runtime.ts` → `runtime-barrel.ts`, so
 * every server replica, sandbox host and `aai dev` start used to pay for all
 * six vendor SDKs even though an agent uses at most one STT and one TTS.
 * Measured on this repo: ~1.15s and ~100MB RSS for the four STT/TTS SDKs, of
 * which `@elevenlabs/elevenlabs-js` alone is ~970ms.
 *
 * `name` is the registry kind, so the opener identifies itself without the
 * vendor package being loaded.
 */
function lazyOpener<Opts, Session>(
  kind: string,
  load: () => Promise<{ open(opts: Opts): Promise<Session> }>,
): { readonly name: string; open(opts: Opts): Promise<Session> } {
  return {
    name: kind,
    async open(opts: Opts): Promise<Session> {
      return (await load()).open(opts);
    },
  };
}

const STT_REGISTRY: Record<string, OpenerRegistryEntry<SttOpener>> = {
  [ASSEMBLYAI_KIND]: {
    envVar: ASSEMBLYAI_API_KEY_ENV,
    open: (d) =>
      lazyOpener(ASSEMBLYAI_KIND, async () =>
        (await import("./stt/assemblyai.ts")).openAssemblyAI(options<AssemblyAIOptions>(d)),
      ),
  },
  [DEEPGRAM_KIND]: {
    envVar: DEEPGRAM_API_KEY_ENV,
    open: (d) =>
      lazyOpener(DEEPGRAM_KIND, async () =>
        (await import("./stt/deepgram.ts")).openDeepgram(options<DeepgramOptions>(d)),
      ),
  },
  [ELEVENLABS_KIND]: {
    envVar: ELEVENLABS_API_KEY_ENV,
    open: (d) =>
      lazyOpener(ELEVENLABS_KIND, async () =>
        (await import("./stt/elevenlabs.ts")).openElevenLabs(options<ElevenLabsOptions>(d)),
      ),
  },
  [SONIOX_KIND]: {
    envVar: SONIOX_API_KEY_ENV,
    open: (d) =>
      lazyOpener(SONIOX_KIND, async () =>
        (await import("./stt/soniox.ts")).openSoniox(options<SonioxOptions>(d)),
      ),
  },
};

const TTS_REGISTRY: Record<string, OpenerRegistryEntry<TtsOpener>> = {
  [CARTESIA_KIND]: {
    envVar: CARTESIA_API_KEY_ENV,
    open: (d) =>
      lazyOpener(CARTESIA_KIND, async () =>
        (await import("./tts/cartesia.ts")).openCartesia(options<CartesiaOptions>(d)),
      ),
  },
  [RIME_KIND]: {
    envVar: RIME_API_KEY_ENV,
    open: (d) =>
      lazyOpener(RIME_KIND, async () =>
        (await import("./tts/rime.ts")).openRime(options<RimeOptions>(d)),
      ),
  },
};

/**
 * Look up a registry entry by descriptor kind, or throw listing what is
 * supported. The supported list is derived from the registry, so it cannot go
 * stale when a provider is added.
 */
function lookupProvider<Entry>(
  registry: Record<string, Entry>,
  kind: string,
  label: string,
): Entry {
  const entry = registry[kind];
  if (!entry) {
    throw new Error(
      `Unknown ${label} provider kind: "${kind}". Supported: ${Object.keys(registry).join(", ")}.`,
    );
  }
  return entry;
}

/** An opener plus the env var holding its credential. */
export type ResolvedOpener<Opener> = {
  readonly opener: Opener;
  /** Env var this provider's key lives in — travels with the opener so no
   *  caller has to re-derive it from a descriptor it no longer holds. */
  readonly envVar: string;
};

/** Resolve an {@link SttProvider} descriptor into a host-side opener + env var. */
export function resolveStt(descriptor: SttProvider): ResolvedOpener<SttOpener> {
  const entry = lookupProvider(STT_REGISTRY, descriptor.kind, "STT");
  return { opener: entry.open(descriptor), envVar: entry.envVar };
}

/** Resolve a {@link TtsProvider} descriptor into a host-side opener + env var. */
export function resolveTts(descriptor: TtsProvider): ResolvedOpener<TtsOpener> {
  const entry = lookupProvider(TTS_REGISTRY, descriptor.kind, "TTS");
  return { opener: entry.open(descriptor), envVar: entry.envVar };
}

/**
 * Register an extra provider kind at runtime, returning an unregister function.
 *
 * This is the seam tests use to inject fakes. It replaced a
 * `SttProvider | SttOpener` union on `RuntimeOptions` that let callers hand in a
 * pre-resolved opener: because such a value carries no `kind`, API-key routing
 * had to sniff `opener.name` and guess, and a provider whose name didn't match
 * its registry kind silently got another vendor's credential. Going through the
 * registry means a fake resolves exactly like a real provider — including its
 * env var — and production code only ever sees descriptors.
 */
function registerKind<Entry>(
  registry: Record<string, Entry>,
  kind: string,
  entry: Entry,
): () => void {
  const previous = Object.hasOwn(registry, kind) ? registry[kind] : undefined;
  registry[kind] = entry;
  return () => {
    if (previous === undefined) delete registry[kind];
    else registry[kind] = previous;
  };
}

/** Register an STT kind. See {@link registerKind}. */
export function registerSttKind(kind: string, entry: OpenerRegistryEntry<SttOpener>): () => void {
  return registerKind(STT_REGISTRY, kind, entry);
}

/** Register a TTS kind. See {@link registerKind}. */
export function registerTtsKind(kind: string, entry: OpenerRegistryEntry<TtsOpener>): () => void {
  return registerKind(TTS_REGISTRY, kind, entry);
}

/** Register an LLM kind. See {@link registerKind}. */
export function registerLlmKind(kind: string, entry: LlmRegistryEntry): () => void {
  return registerKind(LLM_REGISTRY, kind, entry);
}

/** One registry entry per LLM provider kind — adding a provider is one entry here. */
export type LlmRegistryEntry = {
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
  const entry = lookupProvider(LLM_REGISTRY, descriptor.kind, "LLM");
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
  // requireApiKey's process.env fallback mirrors resolveApiKey's, so passing
  // the agent-env value keeps the same lookup order with one implementation.
  return requireApiKey(env[name], name, `${label} LLM`, (msg) => new Error(msg));
}

// ─── Descriptor helpers (used by runtime.ts) ─────────────────────────────────

/** Read a descriptor's `kind`. */
export function descriptorKind(value: object | undefined): string | undefined {
  const kind = (value as { kind?: unknown } | undefined)?.kind;
  return typeof kind === "string" ? kind : undefined;
}

/**
 * The provider credentials an agent actually needs, derived from the same
 * registries that resolve them.
 *
 * Callers that want to check credentials up front (the CLI dev server) would
 * otherwise hardcode `kind === "assemblyai"`-style checks, which go stale on
 * every new provider and are easy to write incompletely — the previous version
 * ignored `tts` and `s2s` entirely, so a Deepgram+Anthropic+Rime agent was
 * never told which of its three keys was missing and failed at first session.
 */
export function requiredProviderEnvVars(agent: {
  stt?: { kind: string } | object | undefined;
  llm?: { kind: string } | object | undefined;
  tts?: { kind: string } | object | undefined;
  s2s?: { kind: string } | object | undefined;
}): string[] {
  const vars = new Set<string>();
  const add = (envVar: string | undefined): void => {
    if (envVar) vars.add(envVar);
  };

  const envVarFor = <E extends { envVar: string }>(
    registry: Record<string, E>,
    descriptor: object | undefined,
  ): string | undefined => registry[descriptorKind(descriptor) ?? ""]?.envVar;

  add(envVarFor(STT_REGISTRY, agent.stt));
  add(envVarFor(TTS_REGISTRY, agent.tts));
  add(envVarFor(LLM_REGISTRY, agent.llm));

  // S2S mode: an explicit descriptor selects its vendor, and its *absence*
  // means the default AssemblyAI S2S path (see createTransportFactory).
  const pipeline = agent.stt !== undefined && agent.llm !== undefined && agent.tts !== undefined;
  if (!pipeline) {
    add(
      descriptorKind(agent.s2s) === OPENAI_REALTIME_KIND
        ? OPENAI_API_KEY_ENV
        : ASSEMBLYAI_API_KEY_ENV,
    );
  }
  return [...vars];
}
