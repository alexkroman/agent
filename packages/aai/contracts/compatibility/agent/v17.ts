// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:agent` epoch 17.
 *
 * Epoch 17 ADDS the five descriptor types `AgentDef`'s own signature has always
 * used. All five were FORGOTTEN exports on the root — declared in the rollup
 * because `AgentDef` references them, exported by nothing — so an author
 * annotating two stages reached into two provider subpaths for types this
 * barrel already publishes the consumer of, and the shipped authoring guide's
 * `agent()` signature block named types no import path on this page could
 * supply.
 *
 * Only `ProviderDescriptor` shows in this capability's export list: the four
 * stage types are published on their own subpaths as well and are owned by
 * those capabilities, under the rule that a name on both `.` and a narrower
 * subpath belongs to the narrower one. `ProviderDescriptor` has no stage of its
 * own — it had four reference pages, one per stage, for one interface — so the
 * root is the narrowest thing that can own the base every stage narrows.
 *
 * Nothing was removed, so epoch 16 is RETAINED and `./v16.ts` compiles
 * unchanged beside this file.
 *
 * `assemblyAIPipeline()` returns the three BASE types now rather than three
 * narrowed AssemblyAI aliases. Spreading it into `agent()` is unaffected, which
 * is what this example pins: the aliases only ever restated the `kind` a
 * factory already sets, and nothing narrowed on it.
 *
 * See `./v3.ts` for what "frozen" obliges and why the imports are relative.
 */

import {
  type AgentDef,
  type AssemblyAIPipelineOptions,
  agent,
  assemblyAIPipeline,
  type LlmProvider,
  type ProviderDescriptor,
  type S2sProvider,
  type SttProvider,
  type TtsProvider,
} from "../../../index.ts";

/**
 * A stage picked in a helper of its own, which is the line epoch 17 makes
 * writable from one import path.
 *
 * Before it the return annotation came from `@alexkroman1/aai/stt` while
 * `agent()` came from the root, so a two-stage helper wrote three import lines
 * for one declaration.
 */
export function speechFor(region: "us" | "eu"): { stt: SttProvider; tts: TtsProvider } {
  const { stt, tts } = assemblyAIPipeline({ region });
  return { stt, tts };
}

/** The preset's three stages, annotated with the base types it now returns. */
const presetOptions: AssemblyAIPipelineOptions = { voice: "jane", region: "us" };
const preset: { stt: SttProvider; llm: LlmProvider; tts: TtsProvider } =
  assemblyAIPipeline(presetOptions);

/** The declaration, spread the way the preset is meant to be used. */
export const support: AgentDef = agent({
  name: "Support",
  systemPrompt: "You are a support agent. Be brief.",
  ...preset,
});

/** One stage swapped, the other two left to `defaultProviders`. */
export const euSpeech = agent({ name: "EU", ...speechFor("eu") });

/**
 * The base every stage narrows, readable from the root now rather than from
 * whichever of four subpaths an author happened to import already.
 */
export type StageBase = ProviderDescriptor<string, Record<string, unknown>>;
export const base: StageBase = preset.llm;

/** The fourth stage is the same shape, and it refuses the pipeline fields. */
export function isS2s(descriptor: S2sProvider | undefined): boolean {
  return descriptor?.kind === "assemblyai";
}
