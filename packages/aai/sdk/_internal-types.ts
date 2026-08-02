// Copyright 2025 the AAI authors. MIT license.

import type { JSONSchema7 } from "json-schema";
import { z } from "zod";
import { DEFAULT_GREETING, DEFAULT_SYSTEM_PROMPT } from "./agent-defaults.ts";
import { assertPipelineTuning, assertProviderTriple, assertSilencePolicy } from "./config-rules.ts";
import { ProviderDescriptorSchema } from "./manifest.ts";
import { assertAssemblyAITtsLanguage } from "./providers/tts/assemblyai.ts";
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
  // Defaulted rather than required: `agent()` fills these in, but a raw
  // `export default {...}` agent.ts (no `agent()` wrapper) reaches
  // `toAgentConfig` without them — the old mapper shipped a config with
  // `greeting: undefined` (typed `string`, silently invalid) for such agents.
  systemPrompt: z.string().default(DEFAULT_SYSTEM_PROMPT),
  greeting: z.string().default(DEFAULT_GREETING),
  sttPrompt: z.string().optional(),
  maxSteps: z.number().int().positive().optional(),
  toolChoice: ToolChoiceSchema.optional(),
  builtinTools: z.array(BuiltinToolSchema).readonly().optional(),
  idleTimeoutMs: z.number().nonnegative().optional(),
  silenceTimeoutMs: z.number().positive().optional(),
  silencePrompt: z.string().optional(),
  minBargeInWords: z.number().int().min(1).optional(),
  interruptionMinDurationMs: z.number().int().nonnegative().optional(),
  holdPhrase: z.string().optional(),
  errorPhrase: z.string().optional(),
  startFailurePhrase: z.string().optional(),
  falseInterruptionTimeoutMs: z.number().int().nonnegative().optional(),
  stt: ProviderDescriptorSchema.optional(),
  llm: ProviderDescriptorSchema.optional(),
  tts: ProviderDescriptorSchema.optional(),
  s2s: ProviderDescriptorSchema.optional(),
  mode: z.enum(["s2s", "pipeline"]).optional(),
  requiredEnv: z.array(z.string()).readonly().optional(),
});

export type AgentConfig = z.infer<typeof AgentConfigSchema>;

/**
 * `AgentDef` fields that must never cross the serialization boundary — the
 * single deny-list {@link toAgentConfig} strips. Everything else on the agent
 * definition flows into {@link AgentConfig} by default, so a new serializable
 * field works CLI → server → runtime without touching a mapper. A field added
 * to `AgentDef` must appear either in `AgentConfigSchema` or here — the
 * type-level guard in `_internal-types.test.ts` enforces that subtraction.
 */
export const HOST_ONLY_AGENT_FIELDS = ["tools", "state", "syncState"] as const;

export type HostOnlyAgentField = (typeof HOST_ONLY_AGENT_FIELDS)[number];

const HOST_ONLY_FIELD_SET: ReadonlySet<string> = new Set(HOST_ONLY_AGENT_FIELDS);

/**
 * What {@link toAgentConfig} accepts: every serializable {@link AgentConfig}
 * field (`mode` excepted — it is derived, never supplied) plus the host-only
 * fields the deny-list strips. `AgentDef` is assignable to this by
 * construction; the explicit `| undefined` on the host-only members keeps
 * spread call sites (`{...agent, stt: maybeUndefined}`) legal under
 * `exactOptionalPropertyTypes`.
 */
export type AgentConfigSource = Omit<AgentConfig, "mode"> & {
  [K in HostOnlyAgentField]?: unknown;
};

export function toAgentConfig(src: AgentConfigSource): AgentConfig {
  // `assertProviderTriple` enforces that stt/llm/tts are all-or-nothing so the
  // server can trust the resolved mode.
  const mode = assertProviderTriple(src.stt, src.llm, src.tts, src.s2s);
  assertSilencePolicy(mode, src.silenceTimeoutMs, src.silencePrompt);
  assertPipelineTuning(mode, src);
  // Runs inside the generated bundle entry too, so the studio's test_agent
  // surfaces a bad TTS language as a load error rather than shipping a mute agent.
  assertAssemblyAITtsLanguage(src.tts);

  // Deny-list copy: everything defined flows through unless it is host-only.
  // The allow-list mapper this replaces is how fields went missing silently —
  // every field is optional, so an omitted copy is valid TypeScript
  // (which is how fields have gone missing silently before).
  const wire: Record<string, unknown> = { mode };
  for (const [key, value] of Object.entries(src)) {
    if (value === undefined || HOST_ONLY_FIELD_SET.has(key)) continue;
    wire[key] = value;
  }
  // parse() re-validates field shapes, copies arrays (the config must not
  // alias caller-owned arrays), and strips any key the schema doesn't know —
  // a second net under the deny-list for non-serializable strays.
  return AgentConfigSchema.parse(wire);
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
