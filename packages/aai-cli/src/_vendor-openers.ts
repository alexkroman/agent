// Copyright 2026 the AAI authors. MIT license.
/**
 * Leave an undeclared vendor's STT/TTS opener out of the worker bundle.
 *
 * The runtime's provider registry already loads every vendor SDK lazily
 * (`aai-runtime/providers/registry.ts`: `lazyOpener` over an `import()`), so a
 * process that runs the agent pays only for the vendors a session opens. The
 * worker bundle undoes that: it is ONE file (`codeSplitting: false`, see
 * `worker-bundler.ts`), so every lazily imported opener is inlined, vendor SDK
 * and all, whether or not the agent can ever reach it. Measured on the
 * quickstart template — three files, the all-AssemblyAI default pipeline —
 * the worker was 9.8 MB minified, of which `@elevenlabs/elevenlabs-js` alone
 * was 42% of the unminified bytes, and the guest paid ~630 ms to parse it on
 * every cold import.
 *
 * Which STT and TTS vendors an agent can reach is decided ENTIRELY by its
 * built config: the `stt`/`tts` descriptors (fallback members included), which
 * `toAgentConfig` fills with the AssemblyAI defaults for a stage left unset. A
 * dialog state's `voice` and a speaker's `llm` change a voice id or a model,
 * never the stage's kind, and the platform hands `__aaiCreateRuntime` only
 * `{ env, runCode, publicUrl }`. So `buildAgentBundle` builds the agent once
 * WITHOUT the runtime (~0.5 s), reads the kinds off that config, and builds
 * the real worker with the other vendors' openers replaced by a stub.
 *
 * **LLM vendors are deliberately not on this table.** A tool may ask
 * `ctx.generate({ llm })` or a speaker may declare `llm` for any provider at
 * run time, which no config scan can see; the `@ai-sdk/*` packages are small
 * beside the two speech SDKs anyway.
 *
 * The stub keeps the opener's export name so the registry's `import()` still
 * resolves, and throws when CALLED — never at load, since an inlined module's
 * top level runs when the worker is imported. The only way to reach it is a
 * runtime handed a provider the config did not declare (a self-hoster passing
 * `stt`/`tts` to `createRuntime`); the message says what was left out and why.
 *
 * A vendor is matched by the runtime's own module for it, in both shapes the
 * bundler meets: the published `dist/<module>-<hash>.js` chunk tsdown splits
 * each lazy import into, and `src/providers/<stage>/<module>.ts` under
 * `AAI_DEV_SOURCE=1`. `_vendor-openers.test.ts` holds the table to the built
 * runtime, so a renamed chunk or opener fails there rather than silently
 * leaving a vendor in.
 */

import {
  CARTESIA_KIND,
  DEEPGRAM_KIND,
  ELEVENLABS_KIND,
  stageMembers,
} from "@alexkroman1/aai/host-internal";
import { isRecord } from "@alexkroman1/aai/utils";
import type { Plugin } from "vite";

/** One vendor opener the worker can leave out. */
export type VendorOpener = {
  /** The registry kind — the `kind` of the descriptor that opens it. */
  readonly kind: string;
  readonly stage: "stt" | "tts";
  /** The runtime module's basename: `dist/<module>-<hash>.js`, `src/providers/<stage>/<module>.ts`. */
  readonly module: string;
  /** The one function the module exports — what the stub re-exports as a thrower. */
  readonly opener: string;
  /** How the stub's error names the vendor. */
  readonly label: string;
  /** The npm packages only this opener reaches — what leaving it out saves. */
  readonly packages: readonly string[];
};

/** Every vendor opener the bundle can omit. Total over the SDKs worth omitting. */
export const VENDOR_OPENERS: readonly VendorOpener[] = [
  {
    kind: ELEVENLABS_KIND,
    stage: "stt",
    module: "elevenlabs",
    opener: "openElevenLabs",
    label: "ElevenLabs STT",
    packages: ["@elevenlabs/elevenlabs-js"],
  },
  {
    kind: DEEPGRAM_KIND,
    stage: "stt",
    module: "deepgram",
    opener: "openDeepgram",
    label: "Deepgram STT",
    packages: ["@deepgram/sdk"],
  },
  {
    kind: CARTESIA_KIND,
    stage: "tts",
    module: "cartesia",
    opener: "openCartesia",
    label: "Cartesia TTS",
    packages: ["@cartesia/cartesia-js"],
  },
];

/**
 * The STT and TTS kinds a built config declares, each `fallback` member
 * counted. Empty for a config with neither stage (text mode, S2S, a workflow
 * app) and for anything that is not a config at all — which makes
 * {@link vendorsToOmit} omit EVERY vendor for the first and NOTHING for the
 * second, the right answer in both directions.
 */
export function declaredStageKinds(config: unknown): Set<string> | undefined {
  if (!isRecord(config)) return undefined;
  const kinds = new Set<string>();
  for (const stage of ["stt", "tts"] as const) {
    for (const member of stageMembers(config[stage])) {
      if (isRecord(member) && typeof member.kind === "string") kinds.add(member.kind);
    }
  }
  return kinds;
}

/** The vendor kinds a worker built for `config` can leave out. */
export function vendorsToOmit(config: unknown): string[] {
  const declared = declaredStageKinds(config);
  if (declared === undefined) return [];
  return VENDOR_OPENERS.filter((entry) => !declared.has(entry.kind)).map((entry) => entry.kind);
}

const STUB_PREFIX = "\0aai-omitted-vendor:";

/** Is `importer` a module of the runtime — the only place a vendor opener is imported from? */
const fromRuntime = (importer: string): boolean => /[\\/]aai-runtime[\\/]/.test(importer);

/** The one message a stub throws, for the vendor it stands in for. */
export function omittedVendorMessage(entry: VendorOpener): string {
  return (
    `${entry.label} was left out of this bundle: the agent declared no "${entry.kind}" ` +
    `${entry.stage} stage when it was built, and ${entry.packages.join(", ")} is bundled ` +
    "only for a stage the agent names. Declare it in agent.ts (directly or as a " +
    "`fallback` member) and rebuild."
  );
}

/**
 * A Vite plugin that replaces each of `kinds`' runtime opener with a stub.
 *
 * `resolveId` answers only an import FROM the runtime, in either of the two
 * shapes the module doc describes; everything else falls through to Vite.
 */
export function omitVendorOpeners(kinds: readonly string[]): Plugin {
  const entries = VENDOR_OPENERS.filter((entry) => kinds.includes(entry.kind));
  const matchers = entries.map((entry) => ({
    entry,
    dist: new RegExp(`^\\./${entry.module}-[\\w-]+\\.js$`),
    src: `./${entry.stage}/${entry.module}.ts`,
  }));
  return {
    name: "aai:omit-vendor-openers",
    // Before `vite:resolve`, which answers a relative specifier itself and
    // would never let a plugin behind it see the runtime's `./<module>-<hash>.js`.
    enforce: "pre",
    resolveId(source, importer) {
      if (importer === undefined || !fromRuntime(importer)) return null;
      const hit = matchers.find((m) => m.dist.test(source) || source === m.src);
      return hit ? `${STUB_PREFIX}${hit.entry.kind}` : null;
    },
    load(id) {
      if (!id.startsWith(STUB_PREFIX)) return null;
      const entry = entries.find((candidate) => candidate.kind === id.slice(STUB_PREFIX.length));
      if (entry === undefined) return null;
      const message = JSON.stringify(omittedVendorMessage(entry));
      return `export function ${entry.opener}() {\n  throw new Error(${message});\n}\n`;
    },
  };
}
