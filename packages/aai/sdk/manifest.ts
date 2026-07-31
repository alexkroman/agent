// Copyright 2025 the AAI authors. MIT license.
/**
 * Canonical manifest format for directory-based agents.
 *
 * Flows from build → host → sdk. Validated via Zod at the boundary,
 * then used as a plain typed object throughout the runtime.
 */

import { z } from "zod";
import { AllowedHostsSchema } from "./allowed-hosts.ts";
import {
  assertPipelineTuning,
  assertProviderTriple,
  assertSilencePolicy,
  type SessionMode,
} from "./config-rules.ts";
import { DEFAULT_BUILTIN_TOOLS, DEFAULT_MAX_STEPS } from "./constants.ts";
import { assertAssemblyAITtsLanguage } from "./providers/tts/assemblyai.ts";
import type {
  LlmProvider,
  S2sProvider,
  SttProvider,
  TtsProvider,
  VectorProvider,
} from "./providers.ts";
import { BuiltinToolSchema, DEFAULT_GREETING, DEFAULT_SYSTEM_PROMPT } from "./types.ts";

/**
 * Tool definition as it appears in the serialized manifest JSON.
 *
 * This is the JSON-safe representation. Compare with `ToolDef` (in types.ts)
 * which uses Zod schemas for parameters — `agentToolsToSchemas()` in
 * `_internal-types.ts` converts ToolDef → ToolSchema (JSON Schema) for transport.
 */
const ToolManifestSchema = z.object({
  description: z.string(),
  parameters: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Provider descriptor — a `{ kind, options }` pair produced by factories
 * like `assemblyAI(...)` / `anthropic(...)` / `cartesia(...)`. Kept
 * deliberately generic at the schema layer: kind-specific validation lives
 * in the host-side resolver, which knows what each adapter expects.
 *
 * The exception is an option the resolver can only reject *too late to help* —
 * one whose failure surfaces mid-session rather than at open. AssemblyAI TTS's
 * `language` is the case that taught this (`assertAssemblyAITtsLanguage`, run
 * from `parseManifest` and `toAgentConfig`): the service refuses a bad value
 * in-band after the socket is already open, so the only signal was an agent
 * that went mute in production. Those get an assert here, where the CLI and the
 * studio's `test_agent` both see it while the author is still authoring.
 */
export const ProviderDescriptorSchema = z.object({
  kind: z.string().min(1),
  options: z.record(z.string(), z.unknown()),
});

/**
 * Manifest wire schema — defaults live here, so the schema alone resolves a
 * minimal manifest to a full one and the `Manifest` type is derived from it
 * (`z.infer`) rather than re-declared. The hand-written type this replaces
 * duplicated every field (docs live on {@link AgentDef}) and was one more
 * shape a new field could silently miss.
 */
const ManifestSchema = z.object({
  name: z.string().min(1),
  systemPrompt: z.string().default(DEFAULT_SYSTEM_PROMPT),
  greeting: z.string().default(DEFAULT_GREETING),
  sttPrompt: z.string().optional(),
  // Function default so parses never share (or expose for mutation) one array.
  builtinTools: z.array(BuiltinToolSchema).default(() => [...DEFAULT_BUILTIN_TOOLS]),
  maxSteps: z.number().int().positive().default(DEFAULT_MAX_STEPS),
  toolChoice: z.enum(["auto", "required"]).default("auto"),
  // 0 is the documented "disable the idle timer" value — allow it (the runtime
  // and AgentConfigSchema both treat 0 as disabled), so use nonnegative().
  idleTimeoutMs: z.number().int().nonnegative().optional(),
  silenceTimeoutMs: z.number().int().positive().optional(),
  silencePrompt: z.string().min(1).optional(),
  minBargeInWords: z.number().int().min(1).optional(),
  // 0 is the documented "disable" value for the duration gate, the settle
  // windows, and the false-interruption recovery timer — allow it via
  // nonnegative().
  interruptionMinDurationMs: z.number().int().nonnegative().optional(),
  endpointSettleMs: z.number().int().nonnegative().optional(),
  completeSettleMs: z.number().int().nonnegative().optional(),
  // "" is the documented "disable the hold phrase" value — no min(1).
  holdPhrase: z.string().optional(),
  // "" is the documented "disable the error phrase" value — no min(1).
  errorPhrase: z.string().optional(),
  falseInterruptionTimeoutMs: z.number().int().nonnegative().optional(),
  tools: z.record(z.string(), ToolManifestSchema).default({}),
  allowedHosts: AllowedHostsSchema.default([]),
  stt: ProviderDescriptorSchema.optional(),
  llm: ProviderDescriptorSchema.optional(),
  tts: ProviderDescriptorSchema.optional(),
  s2s: ProviderDescriptorSchema.optional(),
  vector: ProviderDescriptorSchema.optional(),
});

/**
 * The provider-descriptor fields, re-typed from the generic parsed shape to
 * the SDK's nominal aliases so `Manifest` consumers meet the same types the
 * factories (`assemblyAI(...)`, `anthropic(...)`) return.
 */
type ManifestProviders = {
  stt?: SttProvider | undefined;
  llm?: LlmProvider | undefined;
  tts?: TtsProvider | undefined;
  s2s?: S2sProvider | undefined;
  vector?: VectorProvider | undefined;
};

/**
 * Normalized agent manifest — all defaulted fields resolved, plus the
 * derived session `mode`. Field semantics are documented on {@link AgentDef};
 * the shape is the schema's, not a second declaration.
 */
export type Manifest = Omit<z.infer<typeof ManifestSchema>, keyof ManifestProviders> &
  ManifestProviders & {
    /**
     * Session mode derived from provider fields:
     * - `"s2s"`: speech-to-speech path (no stt/llm/tts set, or `s2s` set).
     * - `"pipeline"`: pluggable STT → LLM → TTS path (stt + llm + tts all set).
     */
    mode: SessionMode;
  };

/**
 * Parse and normalize a raw agent manifest, applying defaults for all
 * optional fields. Input is typically the JSON from a bundled agent.ts.
 *
 * Key defaults:
 * - `maxSteps`: {@link DEFAULT_MAX_STEPS} (10) — prevents runaway tool-call loops in a single reply
 * - `toolChoice`: "auto" — LLM decides when to use tools vs respond directly
 * - `builtinTools`: {@link DEFAULT_BUILTIN_TOOLS} (think, remember, recall,
 *   calculate) — set explicitly (including `[]`) to override
 */
export function parseManifest(input: unknown): Manifest {
  const parsed = ManifestSchema.parse(input);
  const mode = assertProviderTriple(parsed.stt, parsed.llm, parsed.tts, parsed.s2s);
  assertSilencePolicy(mode, parsed.silenceTimeoutMs, parsed.silencePrompt);
  assertPipelineTuning(mode, parsed);
  assertAssemblyAITtsLanguage(parsed.tts);
  return { ...parsed, mode };
}
