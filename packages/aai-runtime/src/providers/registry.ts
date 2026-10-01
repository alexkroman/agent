// Copyright 2026 the AAI authors. MIT license.
/**
 * The RUNTIME half of each provider registration: one `open` per catalog
 * definition, joined to the SDK half (`@alexkroman1/aai/host-internal`'s
 * `STT_PROVIDERS` / `TTS_PROVIDERS` / `S2S_PROVIDERS`) by `(stage, kind)`.
 *
 * The SDK half is data — kind, credential variable, label, how the factory is
 * spelled — and the SDK may not import an opener (the dependency runs
 * `aai-runtime` → `aai`, one way). So a vendor is ONE definition there and ONE
 * opener here, and the join is checked twice:
 *
 * - **at compile time**: each opener table is typed over the catalog's closed
 *   kind union (`{ [K in SttKind]: … }`), so a vendor added to the catalog and
 *   not here fails `tsc`, and a key here the catalog lacks is an excess
 *   property;
 * - **at run time**: `registry.test.ts` holds every registry's keys and
 *   credential variables equal to the catalog's.
 *
 * The credential variable is never restated here: it is read off the
 * definition when the registry is built, so the preflight, the allowlist and
 * the resolver cannot disagree with the docs table generated from the same
 * record. `resolve.ts` owns lookup, `apiKeyEnv` and `register*Kind`; the LLM
 * table is `_llm-registry.ts`, keyed to `LLM_PROVIDERS` the same way.
 */

import type { LocalSttOptions } from "@alexkroman1/aai/experimental";
import {
  ASSEMBLYAI_STT_KIND,
  ASSEMBLYAI_TTS_KIND,
  CARTESIA_KIND,
  DEEPGRAM_KIND,
  ELEVENLABS_KIND,
  LOCAL_STT_KIND,
  type ProviderDefinition,
  RIME_KIND,
  S2S_PROVIDERS,
  SONIOX_KIND,
  STT_PROVIDERS,
  type SttKind,
  TTS_PROVIDERS,
  type TtsKind,
} from "@alexkroman1/aai/host-internal";
import type {
  AssemblyAISttOptions,
  DeepgramSttOptions,
  ElevenLabsSttOptions,
  SonioxSttOptions,
} from "@alexkroman1/aai/stt";
import type {
  AssemblyAITtsOptions,
  CartesiaTtsOptions,
  RimeTtsOptions,
} from "@alexkroman1/aai/tts";
import type { SttOpener, TtsOpener } from "./openers.ts";

/**
 * One registry entry per STT/TTS provider kind — the kind's env var and
 * opener factory live together, so an unmapped kind cannot silently resolve
 * the wrong vendor's key.
 *
 * `O` is the options bag the kind's own factory declared. A descriptor carries
 * it as `Record<string, unknown>` on the wire, and the default keeps that shape
 * for an entry that reads the bag loosely; an entry that names its bag gets it
 * typed without a cast of its own. The one place the wire shape meets a
 * declared one is `openEntry` in `resolve.ts`, and a kind is its whole
 * justification: the registry picked this entry BY the descriptor's `kind`.
 *
 * What `registerSttKind` / `registerTtsKind` take — the documented way for a
 * HOST to add a vendor this SDK does not ship ("Your own provider" on the docs
 * site's Voices and models page). A registered kind resolves exactly like a
 * catalog one, its credential variable included.
 */
export type OpenerRegistryEntry<Opener, O extends object = Record<string, unknown>> = {
  readonly envVar: string;
  readonly open: (descriptor: { options: O }) => Opener;
};

/**
 * Any entry, whatever bag it declared. `never` is the bottom of every `O`, so
 * each entry's `open` is assignable here by contravariance and the registry
 * stores them without erasing anything at the definition site.
 */
export type AnyOpenerEntry<Opener> = OpenerRegistryEntry<Opener, never>;

/**
 * Wrap a dynamically-imported opener so its vendor SDK loads on first `open()`
 * instead of at module load.
 *
 * The registry is reachable from `host/runtime.ts` → `runtime-barrel.ts`, so
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
  load: () => Promise<{ open(options: Opts): Promise<Session> }>,
): { readonly name: string; open(options: Opts): Promise<Session> } {
  return {
    name: kind,
    async open(options: Opts): Promise<Session> {
      return (await load()).open(options);
    },
  };
}

/** The opener for each catalog STT kind — total over `SttKind`, nothing else. */
const STT_OPENERS: { readonly [K in SttKind]: AnyOpenerEntry<SttOpener>["open"] } = {
  [ASSEMBLYAI_STT_KIND]: (d: { options: AssemblyAISttOptions }) =>
    lazyOpener(ASSEMBLYAI_STT_KIND, async () =>
      (await import("./stt/assemblyai.ts")).openAssemblyAI(d.options),
    ),
  [DEEPGRAM_KIND]: (d: { options: DeepgramSttOptions }) =>
    lazyOpener(DEEPGRAM_KIND, async () =>
      (await import("./stt/deepgram.ts")).openDeepgram(d.options),
    ),
  [ELEVENLABS_KIND]: (d: { options: ElevenLabsSttOptions }) =>
    lazyOpener(ELEVENLABS_KIND, async () =>
      (await import("./stt/elevenlabs.ts")).openElevenLabs(d.options),
    ),
  [SONIOX_KIND]: (d: { options: SonioxSttOptions }) =>
    lazyOpener(SONIOX_KIND, async () => (await import("./stt/soniox.ts")).openSoniox(d.options)),
  // A model on the developer's own machine takes no credential by default: its
  // definition names NO env var, so `requiredProviderEnvVars` demands none, and
  // a descriptor's `apiKeyEnv` still routes a bearer token when set.
  [LOCAL_STT_KIND]: (d: { options: LocalSttOptions }) =>
    lazyOpener(LOCAL_STT_KIND, async () =>
      (await import("./stt/local.ts")).openLocalStt(d.options),
    ),
};

/** The opener for each catalog TTS kind — total over `TtsKind`, nothing else. */
const TTS_OPENERS: { readonly [K in TtsKind]: AnyOpenerEntry<TtsOpener>["open"] } = {
  [CARTESIA_KIND]: (d: { options: CartesiaTtsOptions }) =>
    lazyOpener(CARTESIA_KIND, async () =>
      (await import("./tts/cartesia.ts")).openCartesia(d.options),
    ),
  [RIME_KIND]: (d: { options: RimeTtsOptions }) =>
    lazyOpener(RIME_KIND, async () => (await import("./tts/rime.ts")).openRime(d.options)),
  [ASSEMBLYAI_TTS_KIND]: (d: { options: AssemblyAITtsOptions }) =>
    lazyOpener(ASSEMBLYAI_TTS_KIND, async () =>
      (await import("./tts/assemblyai.ts")).openAssemblyAITts(d.options),
    ),
};

/**
 * Join a stage's catalog definitions to its host halves (an opener, an LLM
 * client), in catalog order, through `join`. A definition with no host half is
 * left out.
 */
export function bind<Client, Entry>(
  definitions: readonly ProviderDefinition[],
  clients: Readonly<Record<string, Client>>,
  join: (definition: ProviderDefinition, client: Client) => Entry,
): Record<string, Entry> {
  const registry: Record<string, Entry> = {};
  for (const definition of definitions) {
    const client = clients[definition.kind];
    if (client !== undefined) registry[definition.kind] = join(definition, client);
  }
  return registry;
}

/** An opener's registry entry: its credential variable from the definition. */
const openerEntry = <Opener>(
  definition: ProviderDefinition,
  open: AnyOpenerEntry<Opener>["open"],
): AnyOpenerEntry<Opener> => ({ envVar: definition.envVar, open });

/** The STT registry — mutable, because `registerSttKind` writes it. */
export const STT_REGISTRY: Record<string, AnyOpenerEntry<SttOpener>> = bind(
  STT_PROVIDERS,
  STT_OPENERS,
  openerEntry<SttOpener>,
);

/** The TTS registry — mutable, because `registerTtsKind` writes it. */
export const TTS_REGISTRY: Record<string, AnyOpenerEntry<TtsOpener>> = bind(
  TTS_PROVIDERS,
  TTS_OPENERS,
  openerEntry<TtsOpener>,
);

/**
 * One registry entry per S2S provider kind.
 *
 * S2S carries only a credential env var — unlike STT/TTS it has no opener
 * (the transport owns its own socket) and unlike LLM no model factory. It is
 * a registry anyway so that the three things that key off an S2S kind cannot
 * drift: this map, `requiredProviderEnvVars`, and the transport dispatch.
 * They used to be three hand-written comparisons, and they disagreed on the
 * failure mode — `buildTransport` threw on an unrecognized kind while the
 * credential derivation FELL THROUGH to AssemblyAI, so a third S2S vendor
 * would have made the deploy preflight (`aai-server/deploy.ts`) and `aai dev`
 * demand the wrong key and never name the right one.
 */
export const S2S_REGISTRY: Readonly<Record<string, { readonly envVar: string }>> =
  Object.fromEntries(S2S_PROVIDERS.map((d) => [d.kind, { envVar: d.envVar }]));

/** The S2S kinds this build resolves — the catalog's, re-exported for the dispatch. */
export type { S2sKind } from "@alexkroman1/aai/host-internal";
