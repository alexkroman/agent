// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:agent` epoch 18.
 *
 * **Moved for a TRANSITIVE reason, and no field of `agent()` changed.** The
 * export list is identical to epoch 17's and every signature this capability
 * owns is unchanged. What moved is `WorkflowClient`, which gained `lastLine` at
 * `aai:workflow` epoch 10 (see `../workflow/v10.ts`): `AgentDef.tools` is a map
 * of `ToolDef`, a tool's `execute` takes a `ToolContext`, and `ctx.workflows` is
 * a `WorkflowClient` — so the declaration lands in this capability's report and
 * the hash moved with it. Epoch 17 is RETAINED and `./v17.ts` compiles unchanged
 * beside this file.
 *
 * That reach is the mechanism working rather than noise. `includeForgottenExports`
 * is on precisely because a type a public signature MENTIONS is part of the
 * shape a consumer has to satisfy even when it has no name to import it by, and
 * `AgentDef` mentions most of the SDK. The cost is that this capability bumps
 * for changes it did not make; the alternative is a contract that misses the
 * ones it did. The reason to keep an example beside the record is that the
 * distinction is invisible from the hash alone — this file is what says "the
 * declaration is the same one".
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

/** Unchanged from epoch 17: a stage picked in a helper of its own. */
export function speechFor(region: "us" | "eu"): { stt: SttProvider; tts: TtsProvider } {
  const { stt, tts } = assemblyAIPipeline({ region });
  return { stt, tts };
}

/** Unchanged from epoch 17: the preset's three stages, annotated base-typed. */
const presetOptions: AssemblyAIPipelineOptions = { voice: "jane", region: "us" };
const preset: { stt: SttProvider; llm: LlmProvider; tts: TtsProvider } =
  assemblyAIPipeline(presetOptions);

/** Unchanged from epoch 17: the declaration, spread as the preset intends. */
export const support: AgentDef = agent({
  name: "Support",
  systemPrompt: "You are a support agent. Be brief.",
  ...preset,
});

/** Unchanged from epoch 17: one stage swapped, the other two defaulted. */
export const euSpeech = agent({ name: "EU", ...speechFor("eu") });

/** Unchanged from epoch 17: the base every stage narrows, read from the root. */
export type StageBase = ProviderDescriptor<string, Record<string, unknown>>;
export const base: StageBase = preset.llm;

/** Unchanged from epoch 17: the fourth stage refuses the pipeline fields. */
export function isS2s(descriptor: S2sProvider | undefined): boolean {
  return descriptor?.kind === "assemblyai";
}
