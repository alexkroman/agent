// Copyright 2025 the AAI authors. MIT license.

import type { JSONSchema7 } from "json-schema";
import { z } from "zod";
import { ProviderDescriptorSchema } from "./manifest.ts";
import {
  assertPipelineTuning,
  assertProviderTriple,
  assertSilencePolicy,
  type KvProvider,
  type LlmProvider,
  type S2sProvider,
  type SttProvider,
  type TtsProvider,
  type VectorProvider,
} from "./providers.ts";
import type { Message } from "./types.ts";
import { BuiltinToolSchema, ToolChoiceSchema, type ToolDef } from "./types.ts";

export interface ExecuteToolOptions {
  signal?: AbortSignal;
  toolCallId?: string;
}

export type ExecuteTool = (
  name: string,
  args: Readonly<Record<string, unknown>>,
  sessionId?: string,
  messages?: readonly Message[],
  opts?: ExecuteToolOptions,
) => Promise<string>;

// ─── AgentConfig ────────────────────────────────────────────────────────────

// JSON-safe subset of the agent definition, transmitted between worker and
// host via structured clone.
export const AgentConfigSchema = z.object({
  name: z.string().min(1),
  systemPrompt: z.string(),
  greeting: z.string(),
  sttPrompt: z.string().optional(),
  maxSteps: z.number().int().positive().optional(),
  toolChoice: ToolChoiceSchema.optional(),
  builtinTools: z.array(BuiltinToolSchema).readonly().optional(),
  idleTimeoutMs: z.number().nonnegative().optional(),
  silenceTimeoutMs: z.number().positive().optional(),
  silencePrompt: z.string().optional(),
  minBargeInWords: z.number().int().min(1).optional(),
  endpointSettleMs: z.number().int().nonnegative().optional(),
  completeSettleMs: z.number().int().nonnegative().optional(),
  holdPhrase: z.string().optional(),
  falseInterruptionTimeoutMs: z.number().int().nonnegative().optional(),
  stt: ProviderDescriptorSchema.optional(),
  llm: ProviderDescriptorSchema.optional(),
  tts: ProviderDescriptorSchema.optional(),
  s2s: ProviderDescriptorSchema.optional(),
  mode: z.enum(["s2s", "pipeline"]).optional(),
  kv: ProviderDescriptorSchema.optional(),
  vector: ProviderDescriptorSchema.optional(),
});

export type AgentConfig = z.infer<typeof AgentConfigSchema>;

// Covers both `AgentDef` (where `maxSteps` may be a function) and
// `IsolateConfig` (where it is always a number).
interface AgentConfigSource {
  name: string;
  systemPrompt: string;
  greeting: string;
  sttPrompt?: string | undefined;
  maxSteps?: number | undefined;
  toolChoice?: AgentConfig["toolChoice"] | undefined;
  builtinTools?: Readonly<AgentConfig["builtinTools"]> | undefined;
  idleTimeoutMs?: number | undefined;
  silenceTimeoutMs?: number | undefined;
  silencePrompt?: string | undefined;
  minBargeInWords?: number | undefined;
  endpointSettleMs?: number | undefined;
  completeSettleMs?: number | undefined;
  holdPhrase?: string | undefined;
  falseInterruptionTimeoutMs?: number | undefined;
  stt?: SttProvider | undefined;
  llm?: LlmProvider | undefined;
  tts?: TtsProvider | undefined;
  s2s?: S2sProvider | undefined;
  kv?: KvProvider | undefined;
  vector?: VectorProvider | undefined;
}

/** Copy the defined pipeline voice-tuning fields into a config-shaped partial. */
function pipelineTuningConfig(src: AgentConfigSource): Partial<AgentConfig> {
  return {
    ...(src.minBargeInWords !== undefined ? { minBargeInWords: src.minBargeInWords } : {}),
    ...(src.endpointSettleMs !== undefined ? { endpointSettleMs: src.endpointSettleMs } : {}),
    ...(src.completeSettleMs !== undefined ? { completeSettleMs: src.completeSettleMs } : {}),
    ...(src.holdPhrase !== undefined ? { holdPhrase: src.holdPhrase } : {}),
    ...(src.falseInterruptionTimeoutMs !== undefined
      ? { falseInterruptionTimeoutMs: src.falseInterruptionTimeoutMs }
      : {}),
  };
}

export function toAgentConfig(src: AgentConfigSource): AgentConfig {
  // `assertProviderTriple` enforces that stt/llm/tts are all-or-nothing so the
  // server can trust the resolved mode.
  const mode = assertProviderTriple(src.stt, src.llm, src.tts, src.s2s);
  assertSilencePolicy(mode, src.silenceTimeoutMs, src.silencePrompt);
  assertPipelineTuning(mode, src);

  const config: AgentConfig = {
    name: src.name,
    systemPrompt: src.systemPrompt,
    greeting: src.greeting,
    mode,
  };
  if (src.sttPrompt !== undefined) config.sttPrompt = src.sttPrompt;
  if (src.maxSteps !== undefined) config.maxSteps = src.maxSteps;
  if (src.toolChoice !== undefined) config.toolChoice = src.toolChoice;
  if (src.builtinTools) config.builtinTools = [...src.builtinTools];
  if (src.idleTimeoutMs !== undefined) config.idleTimeoutMs = src.idleTimeoutMs;
  if (src.silenceTimeoutMs !== undefined) config.silenceTimeoutMs = src.silenceTimeoutMs;
  if (src.silencePrompt !== undefined) config.silencePrompt = src.silencePrompt;
  Object.assign(config, pipelineTuningConfig(src));
  if (mode === "pipeline") {
    config.stt = src.stt;
    config.llm = src.llm;
    config.tts = src.tts;
  }
  if (src.s2s !== undefined) config.s2s = src.s2s;
  if (src.kv !== undefined) config.kv = src.kv;
  if (src.vector !== undefined) config.vector = src.vector;
  return config;
}

// ─── ToolSchema ─────────────────────────────────────────────────────────────

// `parameters` must be a valid JSON Schema object — the Vercel AI SDK wraps
// it via `jsonSchema()`.
export const ToolSchemaSchema = z.object({
  type: z.literal("function"),
  name: z.string().min(1),
  description: z.string().min(1),
  parameters: z.record(z.string(), z.unknown()),
});

export type ToolSchema = {
  type: "function";
  name: string;
  description: string;
  parameters: JSONSchema7;
};

export const EMPTY_PARAMS = z.object({});

/**
 * Convert a Zod schema to the JSON Schema shape that S2S providers expect.
 * Strips the `$schema` keyword: `z.toJSONSchema` (Zod v4) tags output with
 * the JSON Schema 2020-12 dialect URI, and some Realtime/S2S providers
 * either reject the field outright or ship it through to the underlying
 * model with a malformed function spec — observed empirically as tool
 * calls that arrive with `args: {}` even when required params are listed.
 */
export function toToolJsonSchema(zodSchema: z.ZodTypeAny): JSONSchema7 {
  const { $schema: _omit, ...rest } = z.toJSONSchema(zodSchema) as Record<string, unknown>;
  return rest as JSONSchema7;
}

export function agentToolsToSchemas(tools: Readonly<Record<string, ToolDef>>): ToolSchema[] {
  return Object.entries(tools).map(([name, def]) => ({
    type: "function",
    name,
    description: def.description,
    parameters: toToolJsonSchema(def.parameters ?? EMPTY_PARAMS),
  }));
}
