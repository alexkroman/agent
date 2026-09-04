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

import type { ProviderEnv, SttOpener, TtsOpener } from "@alexkroman1/aai/host-internal";
import {
  ASSEMBLYAI_S2S_API_KEY_ENV,
  ASSEMBLYAI_S2S_KIND,
  ASSEMBLYAI_STT_API_KEY_ENV,
  ASSEMBLYAI_STT_KIND,
  ASSEMBLYAI_TTS_API_KEY_ENV,
  ASSEMBLYAI_TTS_KIND,
  CARTESIA_API_KEY_ENV,
  CARTESIA_KIND,
  DEEPGRAM_API_KEY_ENV,
  DEEPGRAM_KIND,
  ELEVENLABS_API_KEY_ENV,
  ELEVENLABS_KIND,
  OPENAI_S2S_API_KEY_ENV,
  OPENAI_S2S_KIND,
  RIME_API_KEY_ENV,
  RIME_KIND,
  SONIOX_API_KEY_ENV,
  SONIOX_KIND,
} from "@alexkroman1/aai/host-internal";
import type { LlmProvider } from "@alexkroman1/aai/llm";
import type { S2sProvider } from "@alexkroman1/aai/s2s";
import type {
  AssemblyAISttOptions,
  DeepgramSttOptions,
  ElevenLabsSttOptions,
  SonioxSttOptions,
  SttProvider,
} from "@alexkroman1/aai/stt";
import type {
  AssemblyAITtsOptions,
  CartesiaTtsOptions,
  RimeTtsOptions,
  TtsProvider,
} from "@alexkroman1/aai/tts";
import type { LanguageModel } from "ai";
import type { LlmRegistryEntry } from "./_llm-registry.ts";
import { LLM_REGISTRY } from "./_llm-registry.ts";
import { options, requireApiKey } from "./_utils.ts";

/**
 * Look up a provider credential in the agent's own env (set via
 * `aai secret put`, or `.env` in self-hosted mode). Returns `""` when absent —
 * the caller decides whether that's fatal.
 *
 * This deliberately does NOT fall back to the host's `process.env`. On the
 * managed platform the host process may hold platform-owned credentials
 * under exactly the names a tenant descriptor resolves; with a fallback, an
 * agent that supplied no credential of its own would silently borrow the
 * platform's. Whoever builds `env` decides what a provider can authenticate
 * with; see `withHostCredentialFallback` for the self-hosted opt-in.
 */
export function resolveApiKey(envVar: string, env: ProviderEnv): string {
  return env[envVar] ?? "";
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
  [ASSEMBLYAI_STT_KIND]: {
    envVar: ASSEMBLYAI_STT_API_KEY_ENV,
    open: (d) =>
      lazyOpener(ASSEMBLYAI_STT_KIND, async () =>
        (await import("./stt/assemblyai.ts")).openAssemblyAI(options<AssemblyAISttOptions>(d)),
      ),
  },
  [DEEPGRAM_KIND]: {
    envVar: DEEPGRAM_API_KEY_ENV,
    open: (d) =>
      lazyOpener(DEEPGRAM_KIND, async () =>
        (await import("./stt/deepgram.ts")).openDeepgram(options<DeepgramSttOptions>(d)),
      ),
  },
  [ELEVENLABS_KIND]: {
    envVar: ELEVENLABS_API_KEY_ENV,
    open: (d) =>
      lazyOpener(ELEVENLABS_KIND, async () =>
        (await import("./stt/elevenlabs.ts")).openElevenLabs(options<ElevenLabsSttOptions>(d)),
      ),
  },
  [SONIOX_KIND]: {
    envVar: SONIOX_API_KEY_ENV,
    open: (d) =>
      lazyOpener(SONIOX_KIND, async () =>
        (await import("./stt/soniox.ts")).openSoniox(options<SonioxSttOptions>(d)),
      ),
  },
};

const TTS_REGISTRY: Record<string, OpenerRegistryEntry<TtsOpener>> = {
  [CARTESIA_KIND]: {
    envVar: CARTESIA_API_KEY_ENV,
    open: (d) =>
      lazyOpener(CARTESIA_KIND, async () =>
        (await import("./tts/cartesia.ts")).openCartesia(options<CartesiaTtsOptions>(d)),
      ),
  },
  [RIME_KIND]: {
    envVar: RIME_API_KEY_ENV,
    open: (d) =>
      lazyOpener(RIME_KIND, async () =>
        (await import("./tts/rime.ts")).openRime(options<RimeTtsOptions>(d)),
      ),
  },
  [ASSEMBLYAI_TTS_KIND]: {
    envVar: ASSEMBLYAI_TTS_API_KEY_ENV,
    open: (d) =>
      lazyOpener(ASSEMBLYAI_TTS_KIND, async () =>
        (await import("./tts/assemblyai.ts")).openAssemblyAITts(options<AssemblyAITtsOptions>(d)),
      ),
  },
};

/**
 * S2S provider kinds. A closed union rather than `string`, so
 * {@link isS2sKind} can narrow and the transport dispatch in
 * `runtime-transport.ts` is exhaustive — adding a kind here is a compile
 * error there until it has a builder.
 */
export type S2sKind = typeof ASSEMBLYAI_S2S_KIND | typeof OPENAI_S2S_KIND;

/**
 * One registry entry per S2S provider kind.
 *
 * S2S carries only a credential env var — unlike STT/TTS it has no opener
 * (the transport owns its own socket) and unlike LLM no model factory. It is
 * a registry anyway so that the three things that key off an S2S kind cannot
 * drift: this map, {@link requiredProviderEnvVars}, and the transport
 * dispatch. They used to be three hand-written comparisons, and they
 * disagreed on the failure mode — `buildTransport` threw on an unrecognized
 * kind while the credential derivation FELL THROUGH to AssemblyAI, so a
 * third S2S vendor would have made the deploy preflight
 * (`aai-server/deploy.ts`) and `aai dev` demand the wrong key and never
 * name the right one.
 */
const S2S_REGISTRY: Record<S2sKind, { readonly envVar: string }> = {
  [ASSEMBLYAI_S2S_KIND]: { envVar: ASSEMBLYAI_S2S_API_KEY_ENV },
  [OPENAI_S2S_KIND]: { envVar: OPENAI_S2S_API_KEY_ENV },
};

/** Is `kind` an S2S provider this build can resolve? Narrows for the dispatch. */
export function isS2sKind(kind: string | undefined): kind is S2sKind {
  return kind !== undefined && Object.hasOwn(S2S_REGISTRY, kind);
}

/**
 * The env var an {@link S2sProvider} descriptor's credential lives in,
 * honouring a per-descriptor `apiKeyEnv` override exactly as the STT/TTS/LLM
 * resolvers do. Throws on an unknown kind, listing what is supported.
 */
export function resolveS2sEnvVar(descriptor: S2sProvider): string {
  const entry = lookupProvider(S2S_REGISTRY, descriptor.kind, "S2S");
  return envVarOf(entry, descriptor);
}

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

/**
 * A descriptor's own credential env var, overriding the registry default.
 *
 * The registry maps ONE env var per provider kind, which is right until two
 * stages of the same vendor need different accounts. AssemblyAI's three
 * `*_API_KEY_ENV` constants are distinct names for the same string
 * (`ASSEMBLYAI_API_KEY`), so without this there is no way to run STT against a
 * staging cluster while the LLM gateway and TTS stay on production — and the
 * keys are strictly environment-scoped, measured: a production key is rejected
 * by the sandbox STT cluster (1008) and a staging key is rejected by production
 * STT and TTS. A mixed deployment therefore needs two credentials live at once.
 *
 * It names a VARIABLE, never a key, so the descriptor stays secret-free and
 * safe to serialize — the same property that keeps API keys out of deployed
 * configs. A non-string or empty value falls through to the registry default
 * rather than resolving to `""`.
 */
function descriptorEnvVar(descriptor: object | undefined): string | undefined {
  // `bag`, not `options` — that name is an imported helper used throughout the
  // registries below, and shadowing it here reads as a call site of it.
  const bag = (descriptor as { options?: unknown } | undefined)?.options;
  const value = (bag as Record<string, unknown> | undefined)?.apiKeyEnv;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Which variable a descriptor's credential really lives in: its own
 * `apiKeyEnv` if it named one, otherwise the registry default.
 *
 * Spelled ONCE because it was spelled five times, and the fifth was written
 * only after the omission had shipped — `requiredProviderEnvVars` demanded
 * `ASSEMBLYAI_API_KEY` while the session resolved `ASSEMBLYAI_STAGING_KEY`, so
 * the preflight never reported the key it would actually read as absent. That
 * is the silently-wrong-key failure {@link S2S_REGISTRY}'s own doc says these
 * registries exist to prevent, and a sixth reader is a sixth chance at it.
 */
function envVarOf(entry: { envVar: string }, descriptor: object | undefined): string {
  return descriptorEnvVar(descriptor) ?? entry.envVar;
}

/** Resolve an {@link SttProvider} descriptor into a host-side opener + env var. */
export function resolveStt(descriptor: SttProvider): ResolvedOpener<SttOpener> {
  const entry = lookupProvider(STT_REGISTRY, descriptor.kind, "STT");
  return { opener: entry.open(descriptor), envVar: envVarOf(entry, descriptor) };
}

/** Resolve a {@link TtsProvider} descriptor into a host-side opener + env var. */
export function resolveTts(descriptor: TtsProvider): ResolvedOpener<TtsOpener> {
  const entry = lookupProvider(TTS_REGISTRY, descriptor.kind, "TTS");
  return { opener: entry.open(descriptor), envVar: envVarOf(entry, descriptor) };
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
  // The credential vocabulary is derived from these registries, so it moves
  // with them — see ALL_PROVIDER_ENV_VARS.
  refreshProviderEnvVars();
  return () => {
    if (previous === undefined) delete registry[kind];
    else registry[kind] = previous;
    refreshProviderEnvVars();
  };
}

/**
 * Register an STT kind, returning an unregister function.
 *
 * The seam a HOST application substitutes a fake speech stage through — the
 * behaviour eval tier's level-1 target (`packages/aai-evals`) is the in-repo
 * consumer. Registration rather than a pre-resolved opener for the reason above:
 * a fake that goes through the registry resolves exactly like a real provider,
 * its env var included, and production code only ever sees descriptors.
 */
export function registerSttKind(kind: string, entry: OpenerRegistryEntry<SttOpener>): () => void {
  return registerKind(STT_REGISTRY, kind, entry);
}

/** Register a TTS kind. Mirror of {@link registerSttKind}. */
export function registerTtsKind(kind: string, entry: OpenerRegistryEntry<TtsOpener>): () => void {
  return registerKind(TTS_REGISTRY, kind, entry);
}

/** One registry entry per LLM provider kind — see `_llm-registry.ts`. */
export type { LlmRegistryEntry } from "./_llm-registry.ts";

/**
 * Register an LLM kind. Mirror of {@link registerSttKind}, one stage along: the
 * entry builds a Vercel AI SDK `LanguageModel` rather than opening a socket, so
 * it takes a {@link LlmRegistryEntry} instead of an `OpenerRegistryEntry`.
 */
export function registerLlmKind(kind: string, entry: LlmRegistryEntry): () => void {
  return registerKind(LLM_REGISTRY, kind, entry);
}

/**
 * Resolve an {@link LlmProvider} descriptor into a Vercel AI SDK
 * `LanguageModel`.
 *
 * The API key is pulled from the agent's env (e.g. `OPENAI_API_KEY`).
 * Missing keys throw here — the pipeline session would fail on first
 * `streamText` call otherwise, and the error is clearer at construction.
 */
export function resolveLlm(descriptor: LlmProvider, env: Record<string, string>): LanguageModel {
  const entry = lookupProvider(LLM_REGISTRY, descriptor.kind, "LLM");
  const apiKey = requireKey(env, envVarOf(entry, descriptor), entry.label);
  return entry.create(apiKey, descriptor);
}

// ── Helpers ───────────────────────────────────────────────────────────

function requireKey(env: Record<string, string>, name: string, label: string): string {
  // Reads the agent env only — never process.env (see the credential
  // separation notes on resolveApiKey).
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
  /**
   * The agent's front door (`AgentDef.page`). A `"static"` one needs no
   * provider credential at all — see the first branch.
   */
  page?: "voice" | "static" | undefined;
}): string[] {
  // **A workflow app dials no provider, so it needs no provider credential.**
  // `page: "static"` declines `/websocket` with a reason and defaults telephony
  // OFF, so there is no session to open one from — and yet an agent declaring no
  // providers at all fell through to the default-pipeline branch below and
  // required `ASSEMBLYAI_API_KEY`, which `aai dev` answers by reaching for the
  // logged-in key and hard-failing `not_logged_in`. That is a login wall on the
  // first run of a template whose whole pitch is that it needs no credential
  // (`link-digest`, `transcription-workflow`).
  //
  // Checked BEFORE the descriptors rather than only suppressing the default,
  // because by the time a config reaches the deploy preflight `defaultProviders`
  // has already injected the full AssemblyAI triple into it (`toAgentConfig`) —
  // so at that boundary "declared nothing" and "declared the default" are the
  // same object and only `page` still tells them apart.
  //
  // The cost is that a static agent given a voice surface by an EMBEDDER
  // (`createServer({ telephony: true })`, self-hosted) is not preflighted. Its
  // runtime still resolves credentials the ordinary way and reports a missing
  // one at the first call; nothing here gates a session.
  if (agent.page === "static") return [];

  const vars = new Set<string>();
  const add = (envVar: string | undefined): void => {
    if (envVar) vars.add(envVar);
  };

  // Through `envVarOf` like every resolver: this is the site that once skipped
  // the override, and an unknown kind has no default to fall back to — only the
  // override is knowable. Resolution throws on one; a preflight does not.
  const envVarFor = <E extends { envVar: string }>(
    registry: Record<string, E>,
    descriptor: object | undefined,
  ): string | undefined => {
    if (descriptor === undefined) return undefined;
    const entry = registry[descriptorKind(descriptor) ?? ""];
    return entry === undefined ? descriptorEnvVar(descriptor) : envVarOf(entry, descriptor);
  };

  add(envVarFor(STT_REGISTRY, agent.stt));
  add(envVarFor(TTS_REGISTRY, agent.tts));
  add(envVarFor(LLM_REGISTRY, agent.llm));

  // No pipeline triple: either an explicit `s2s` descriptor selects a vendor,
  // or nothing is declared and the default AssemblyAI pipeline is injected.
  const pipeline = agent.stt !== undefined && agent.llm !== undefined && agent.tts !== undefined;
  if (!pipeline) {
    const s2sKind = descriptorKind(agent.s2s);
    // An UNRECOGNIZED s2s kind contributes nothing, matching what an
    // unrecognized stt/tts/llm kind does above. Naming the wrong vendor's key
    // is worse than naming none: this list is what the deploy preflight
    // rejects on, so a wrong entry blocks the deploy AND hides the real key.
    add(
      agent.s2s === undefined
        ? ASSEMBLYAI_STT_API_KEY_ENV
        : (descriptorEnvVar(agent.s2s) ?? (isS2sKind(s2sKind) ? S2S_REGISTRY[s2sKind].envVar : "")),
    );
  }
  return [...vars];
}

/**
 * Backing array for {@link ALL_PROVIDER_ENV_VARS}, rebuilt in place whenever a
 * kind is registered or unregistered.
 *
 * It has to be the SAME array object across a re-derivation, because the two
 * allowlists that read it (`withHostCredentialFallback` via
 * `PROVIDER_CREDENTIAL_ENVS`, and the host handshake's `credentials` screen)
 * hold it as a value rather than calling for it. Re-derived only on a registry
 * mutation, which is a test/host-application seam and never a hot path.
 */
const allProviderEnvVars: string[] = [];

/** Re-derive the vocabulary from the four registries, in place. */
function refreshProviderEnvVars(): void {
  const derived = new Set([
    ...Object.values(STT_REGISTRY).map((e) => e.envVar),
    ...Object.values(TTS_REGISTRY).map((e) => e.envVar),
    ...Object.values(LLM_REGISTRY).map((e) => e.envVar),
    ...Object.values(S2S_REGISTRY).map((e) => e.envVar),
    // The descriptor-less default: no `s2s` field and no pipeline triple means
    // the injected AssemblyAI pipeline, which no registry entry represents.
    ASSEMBLYAI_STT_API_KEY_ENV,
  ]);
  allProviderEnvVars.length = 0;
  allProviderEnvVars.push(...derived);
}
refreshProviderEnvVars();

/**
 * Every STT/TTS/LLM/S2S credential name any provider can resolve, derived from
 * the same registries — so adding a provider needs no change here.
 *
 * Unlike {@link requiredProviderEnvVars} (what one agent needs), this is the
 * whole vocabulary. It bounds `withHostCredentialFallback`: only these names
 * may be copied from a host environment, so no unrelated host variable can
 * reach `ctx.env`.
 *
 * **LIVE, not a module-load snapshot.** The registries are mutable — that is
 * what `registerSttKind`/`registerTtsKind`/`registerLlmKind` are for, and the
 * eval tier's level-1 target uses one in production code paths. A snapshot left
 * a registered kind's env var outside BOTH allowlists at once: the host-mode
 * handshake rejects it by name as an unknown credential, and
 * `withHostCredentialFallback` silently declines to copy it, so a fake or a
 * host application's own provider cannot be given a key.
 */
export const ALL_PROVIDER_ENV_VARS: readonly string[] = allProviderEnvVars;
