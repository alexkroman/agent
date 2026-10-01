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

import type { ProviderEnv } from "@alexkroman1/aai/host-internal";
import {
  ASSEMBLYAI_STT_API_KEY_ENV,
  fallbackMembers,
  isFallbackDescriptor,
} from "@alexkroman1/aai/host-internal";
import type { LlmProvider } from "@alexkroman1/aai/llm";
import type { S2sProvider } from "@alexkroman1/aai/s2s";
import type { SttProvider } from "@alexkroman1/aai/stt";
import type { TtsProvider } from "@alexkroman1/aai/tts";
import type { LanguageModel } from "ai";
import { fallbackLanguageModel } from "./_fallback-llm.ts";
import type { LlmRegistryEntry } from "./_llm-registry.ts";
import { LLM_REGISTRY, llmEntryFor } from "./_llm-registry.ts";
import { descriptorEnvVar, envVarOf, type ProviderEnvVarsQuery } from "./_provider-env-var.ts";
import { requireApiKey } from "./_utils.ts";
import { createFallbackSttOpener, createFallbackTtsOpener } from "./fallback.ts";
import type { SttOpener, TtsOpener } from "./openers.ts";
import {
  type AnyOpenerEntry,
  type OpenerRegistryEntry,
  S2S_REGISTRY,
  type S2sKind,
  STT_REGISTRY,
  TTS_REGISTRY,
} from "./registry.ts";

export type { OpenerRegistryEntry, S2sKind } from "./registry.ts";

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
 * Open a descriptor with the entry its `kind` selected — the ONE narrowing from
 * the wire bag to the bag that entry declared. Every entry used to call an
 * `options<T>(descriptor)` helper whose body was an `as unknown as T`.
 */
function openEntry<Opener>(
  entry: AnyOpenerEntry<Opener>,
  descriptor: { options: Record<string, unknown> },
): Opener {
  return entry.open(descriptor as { options: never });
}

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
 * Resolve an {@link SttProvider} descriptor into a host-side opener + env var.
 *
 * A `fallback([...])` resolves each member through this same function and
 * wraps them (`fallback.ts`). Its members carry different credentials, so it
 * takes the provider `env` to read each one's key from; without it every
 * member is handed the key the caller passes to `open()`. The `envVar` that
 * travels with a fallback opener is the PRIMARY's.
 */
export function resolveStt(descriptor: SttProvider, env?: ProviderEnv): ResolvedOpener<SttOpener> {
  if (isFallbackDescriptor(descriptor)) {
    const members = resolveMembers(descriptor, "STT", (d) => resolveStt(d, env));
    return { opener: createFallbackSttOpener(members, env), envVar: members[0]?.envVar ?? "" };
  }
  const entry = lookupProvider(STT_REGISTRY, descriptor.kind, "STT");
  return { opener: openEntry(entry, descriptor), envVar: envVarOf(entry, descriptor) };
}

/** Resolve a {@link TtsProvider} descriptor. Mirror of {@link resolveStt}. */
export function resolveTts(descriptor: TtsProvider, env?: ProviderEnv): ResolvedOpener<TtsOpener> {
  if (isFallbackDescriptor(descriptor)) {
    const members = resolveMembers(descriptor, "TTS", (d) => resolveTts(d, env));
    return { opener: createFallbackTtsOpener(members, env), envVar: members[0]?.envVar ?? "" };
  }
  const entry = lookupProvider(TTS_REGISTRY, descriptor.kind, "TTS");
  return { opener: openEntry(entry, descriptor), envVar: envVarOf(entry, descriptor) };
}

/**
 * A fallback's members, each resolved, with its kind kept for the failover
 * event. Fewer than two is a malformed config (the factory refuses one), and
 * an unknown member kind throws here, at resolution, as a lone one would.
 */
function resolveMembers<R>(
  descriptor: object,
  label: string,
  resolve: (member: { kind: string; options: Record<string, unknown> }) => R,
): (R & { kind: string })[] {
  const members = fallbackMembers(descriptor);
  if (members.length < 2) {
    throw new Error(`${label} fallback needs at least two providers to fail over between.`);
  }
  return members.map((member) => ({ ...resolve(member), kind: member.kind }));
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
export function registerSttKind<O extends object = Record<string, unknown>>(
  kind: string,
  entry: OpenerRegistryEntry<SttOpener, O>,
): () => void {
  return registerKind<AnyOpenerEntry<SttOpener>>(STT_REGISTRY, kind, entry);
}

/** Register a TTS kind. Mirror of {@link registerSttKind}. */
export function registerTtsKind<O extends object = Record<string, unknown>>(
  kind: string,
  entry: OpenerRegistryEntry<TtsOpener, O>,
): () => void {
  return registerKind<AnyOpenerEntry<TtsOpener>>(TTS_REGISTRY, kind, entry);
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
  // A fallback resolves EVERY member here, so a missing key on any of them is
  // reported at construction like a lone provider's — not at the moment the
  // primary fails and the secondary is needed.
  if (isFallbackDescriptor(descriptor)) {
    const members = resolveMembers(descriptor, "LLM", (member) => ({
      model: resolveLlm({ kind: member.kind, options: llmOptionsOf(member) }, env),
    }));
    return fallbackLanguageModel(members);
  }
  // A provider with no registered entry still resolves when its descriptor
  // names a `baseUrl` (OpenAI-compatible) — see `llmEntryFor`.
  const entry = llmEntryFor(descriptor) ?? lookupProvider(LLM_REGISTRY, descriptor.kind, "LLM");
  const apiKey = requireKey(env, envVarOf(entry, descriptor), entry.label);
  return entry.create(apiKey, descriptor);
}

/** A fallback member's options as an LLM descriptor's: `model` read, the rest carried. */
function llmOptionsOf(member: { options: Record<string, unknown> }): LlmProvider["options"] {
  const { model } = member.options;
  return { ...member.options, model: typeof model === "string" ? model : "" };
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
export function requiredProviderEnvVars(agent: ProviderEnvVarsQuery): string[] {
  // **A workflow app dials no provider, so it needs no provider credential.**
  // `page: "static"` declines `/websocket` with a reason and defaults telephony
  // OFF, so there is no session to open one from — and yet an agent declaring no
  // providers at all fell through to the default-pipeline branch below and
  // required `ASSEMBLYAI_API_KEY`, which `aai dev` answers by reaching for the
  // logged-in key and hard-failing `not_logged_in`. That is a login wall on the
  // first run of a template whose whole pitch is that it needs no credential
  // (`link-digest-workflow`, `transcription-workflow`).
  //
  // Checked BEFORE the descriptors rather than only suppressing the default,
  // because by the time a config reaches the deploy preflight `defaultProviders`
  // has already injected the full AssemblyAI triple into it (`toAgentConfig`) —
  // so at that boundary "declared nothing" and "declared the default" are the
  // same object and only `page` still tells them apart.
  //
  // The cost is that a static agent given a voice surface by an EMBEDDER
  // (`createRuntimeServer({ telephony: true })`, self-hosted) is not preflighted. Its
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

  // A fallback needs EVERY member's key: one whose secondary has none fails at
  // exactly the moment it is needed, so the preflight names it up front.
  for (const d of stageMembers(agent.stt)) add(envVarFor(STT_REGISTRY, d));
  for (const d of stageMembers(agent.tts)) add(envVarFor(TTS_REGISTRY, d));
  for (const d of stageMembers(agent.llm)) add(llmEnvVarFor(d));

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
        : (descriptorEnvVar(agent.s2s) ??
            (isS2sKind(s2sKind) ? (S2S_REGISTRY[s2sKind]?.envVar ?? "") : "")),
    );
  }
  return [...vars];
}

/** A stage field as the descriptors it dials: a fallback's members, else itself. */
function stageMembers(descriptor: object | undefined): object[] {
  if (descriptor === undefined) return [];
  return isFallbackDescriptor(descriptor) ? fallbackMembers(descriptor) : [descriptor];
}

/** An LLM descriptor's key variable, for the preflight — an unknown kind's override only. */
function llmEnvVarFor(descriptor: object): string | undefined {
  const entry = llmEntryFor(descriptor);
  return entry === undefined ? descriptorEnvVar(descriptor) : envVarOf(entry, descriptor);
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
  // A credential-free kind (`local`) registers "", which is no variable name.
  derived.delete("");
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
