// Copyright 2026 the AAI authors. MIT license.
/**
 * Serializable agent config — the canonical schema that flows CLI → server
 * → runtime.
 *
 * {@link AgentConfig} is the JSON-safe subset of the agent definition,
 * transmitted between worker and host via structured clone. There is exactly
 * one schema (`AgentConfigSchema`); each boundary subtracts an explicit
 * deny-list instead of copying fields (see "One canonical config schema" in
 * `packages/aai/CLAUDE.md`), so a new serializable field reaches the server, the wire, and
 * the runtime by default. {@link toAgentConfig} is the conversion generated
 * bundle entries call.
 */

import type { JSONSchema7 } from "json-schema";
import { z } from "zod";
import { normalizeAgentConveniences } from "./_author-conveniences.ts";
import { DEFAULT_GREETING, DEFAULT_SYSTEM_PROMPT } from "./agent-defaults.ts";
import { assertPipelineTuning, assertProviderTriple, assertSilencePolicy } from "./config-rules.ts";
import { defaultProviders } from "./providers/_default-providers.ts";
import { assertAssemblyAITtsLanguage } from "./providers/tts/assemblyai.ts";
import type { Message } from "./types.ts";
import { BuiltinToolSchema, ToolChoiceSchema } from "./types.ts";

/** Per-call options for an {@link ExecuteTool} invocation. */
export interface ExecuteToolOptions {
  signal?: AbortSignal;
  toolCallId?: string;
}

/**
 * Executes a named tool with parsed arguments and returns its string result.
 * The runtime's tool executor implements this; transports and host mode call
 * through it.
 */
export type ExecuteTool = (
  name: string,
  args: Readonly<Record<string, unknown>>,
  sessionId?: string,
  messages?: readonly Message[],
  opts?: ExecuteToolOptions,
) => Promise<string>;

// ─── AgentConfig ────────────────────────────────────────────────────────────

/**
 * Provider descriptor — a `{ kind, options }` pair produced by factories
 * like `assemblyAIStt(...)` / `anthropic(...)` / `cartesia(...)`. Kept
 * deliberately generic at the schema layer: kind-specific validation lives
 * in the host-side resolver, which knows what each adapter expects.
 *
 * The exception is an option the resolver can only reject *too late to help* —
 * one whose failure surfaces mid-session rather than at open. AssemblyAI TTS's
 * `language` is the case that taught this (`assertAssemblyAITtsLanguage`, run
 * from `toAgentConfig`): the service refuses a bad value in-band after the
 * socket is already open, so the only signal was an agent that went mute in
 * production. Those get an assert here, where the CLI and the studio's
 * `test_agent` both see it while the author is still authoring.
 *
 * @internal
 */
export const ProviderDescriptorSchema = z.object({
  kind: z.string().min(1),
  options: z.record(z.string(), z.unknown()),
});

/**
 * Zod schema for {@link AgentConfig} — the JSON-safe subset of the agent
 * definition, transmitted between worker and host via structured clone.
 *
 * @internal
 */
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

/**
 * JSON-safe subset of the agent definition — the canonical serializable
 * config that flows CLI → server → runtime unchanged.
 */
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

/**
 * `AgentDef` fields that must never cross the serialization boundary — the
 * single deny-list {@link toAgentConfig} strips. Everything else on the agent
 * definition flows into {@link AgentConfig} by default, so a new serializable
 * field works CLI → server → runtime without touching a mapper. A field added
 * to `AgentDef` must appear either in `AgentConfigSchema` or here — the
 * type-level guard in the internal-types test enforces that subtraction.
 */
export const HOST_ONLY_AGENT_FIELDS = ["tools", "state", "syncState"] as const;

/** A host-only `AgentDef` field name stripped by `toAgentConfig` (`tools`, `state`). */
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

/**
 * Convert an agent definition into its serializable {@link AgentConfig},
 * injecting the default providers, deriving the session `mode`, and running
 * the cross-field validation rules. Called from generated bundle entries and
 * the runtime.
 */
export function toAgentConfig(source: AgentConfigSource): AgentConfig {
  // Pipeline stages left unset → filled from the all-AssemblyAI pipeline
  // (S2S requires an explicit `s2s` descriptor). Runs inside the generated
  // bundle entry, so the defaults are baked into the deployed config at
  // build time.
  // Author conveniences (`system`, string `llm`) normalize here too, so a
  // raw `export default {...}` that skipped `agent()` behaves the same.
  const normalized = normalizeAgentConveniences(source) as AgentConfigSource;
  const src = { ...normalized, ...(defaultProviders(normalized) ?? {}) };
  // After the fill, `assertProviderTriple` classifies the mode (and still
  // rejects s2s combined with pipeline stages) so the server can trust it.
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

/**
 * Zod schema for {@link ToolSchema}. `parameters` must be a valid JSON Schema
 * object — the Vercel AI SDK wraps it via `jsonSchema()`.
 *
 * @internal
 */
export const ToolSchemaSchema = z.object({
  type: z.literal("function"),
  name: z.string().min(1),
  description: z.string().min(1),
  parameters: z.record(z.string(), z.unknown()),
});

/**
 * A tool declaration in wire form: name, description, and JSON Schema
 * parameters — the serializable counterpart of `ToolDef`.
 */
export type ToolSchema = {
  type: "function";
  name: string;
  description: string;
  parameters: JSONSchema7;
};
