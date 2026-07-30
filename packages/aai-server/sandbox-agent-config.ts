// Copyright 2026 the AAI authors. MIT license.
/**
 * Mapping the deploy-time {@link IsolateConfig} onto the shapes `createRuntime`
 * expects — the agent definition and its provider options.
 *
 * Split out of `sandbox.ts` because this seam has its own history of dropping
 * fields silently, and every one of those bugs presented as a *working* agent
 * that quietly ignored part of its own config: `builtinTools` (deployed agents
 * lost the default cognitive builtins) and the provider triple (see
 * {@link pipelineProviderOpts}). Keeping the mapping in one small module makes
 * the full set of forwarded fields reviewable at a glance.
 */

import type { BuiltinTool, ToolChoice } from "@alexkroman1/aai";
import { DEFAULT_MAX_STEPS } from "@alexkroman1/aai";
import type { createRuntime } from "@alexkroman1/aai/runtime";
import type { IsolateConfig } from "./rpc-schemas.ts";

/** The agent-definition shape `createRuntime` takes. */
type RuntimeAgent = Parameters<typeof createRuntime>[0]["agent"];

/**
 * Drop the keys whose value is `undefined`, so an unset config field stays
 * absent on the runtime agent rather than becoming an explicit `undefined`.
 *
 * Exists so {@link toRuntimeAgent} can be one flat `key: config.key` block.
 * The `...(config.x !== undefined ? { x: config.x } : {})` spread per field it
 * replaces is what let fields go missing unnoticed — `builtinTools` (every
 * deployed agent silently lost the default cognitive builtins) — because every
 * field is optional, so an omission is valid TypeScript and invisible in
 * review. It also kept the function over the cognitive-complexity cap.
 */
function defined<T extends object>(fields: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  // `Partial<T>` would keep `| undefined` in each value type, which
  // `exactOptionalPropertyTypes` then rejects against AgentDef's `x?: string`.
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}

/** Map the deploy-time IsolateConfig onto the runtime's agent-definition shape. */
export function toRuntimeAgent(config: IsolateConfig): RuntimeAgent {
  return {
    name: config.name,
    systemPrompt: config.systemPrompt,
    greeting: config.greeting ?? "",
    maxSteps: config.maxSteps ?? DEFAULT_MAX_STEPS,
    tools: {},
    ...defined({
      sttPrompt: config.sttPrompt,
      idleTimeoutMs: config.idleTimeoutMs,
      silenceTimeoutMs: config.silenceTimeoutMs,
      silencePrompt: config.silencePrompt,
      minBargeInWords: config.minBargeInWords,
      interruptionMinDurationMs: config.interruptionMinDurationMs,
      endpointSettleMs: config.endpointSettleMs,
      completeSettleMs: config.completeSettleMs,
      holdPhrase: config.holdPhrase,
      errorPhrase: config.errorPhrase,
      falseInterruptionTimeoutMs: config.falseInterruptionTimeoutMs,
      toolChoice: config.toolChoice satisfies ToolChoice | undefined,
      builtinTools: config.builtinTools as BuiltinTool[] | undefined,
      s2s: config.s2s,
    }),
  };
}

/**
 * The agent's pipeline provider descriptors, or `undefined` for a genuine S2S
 * agent.
 *
 * Keyed off the descriptors, **not** `config.mode`, which is optional in
 * `IsolateConfigSchema`: a config carrying all three providers with no `mode`
 * hit the old `config.mode === "pipeline"` gate and lost every one of them, so
 * `createRuntime` resolved S2S and ran a healthy S2S session on the agent's own
 * key — nothing logged, the configured STT/LLM/TTS simply ignored. The
 * descriptors are safe because `IsolateConfigSchema`'s `superRefine` rejects a
 * `mode` that disagrees with them. S2S has to be what the agent declared, never
 * a field that failed to arrive.
 */
export function pipelineProviderOpts(config: IsolateConfig):
  | {
      stt: NonNullable<IsolateConfig["stt"]>;
      llm: NonNullable<IsolateConfig["llm"]>;
      tts: NonNullable<IsolateConfig["tts"]>;
    }
  | undefined {
  const { stt, llm, tts } = config;
  return stt && llm && tts ? { stt, llm, tts } : undefined;
}

/**
 * The deployed agent as an `AgentDef`, *including* its provider descriptors.
 *
 * `toRuntimeAgent` deliberately omits stt/llm/tts because `createSandbox`
 * passes them to `createRuntime` as separate options. Host mode has no such
 * seam — `startHostSession` builds its own runtime from a base agent — so the
 * providers have to ride along, or a pipeline agent would silently fall back
 * to S2S when driven over `?host=1`.
 */
export function toHostBaseAgent(config: IsolateConfig): RuntimeAgent {
  return {
    ...toRuntimeAgent(config),
    ...pipelineProviderOpts(config),
  };
}
