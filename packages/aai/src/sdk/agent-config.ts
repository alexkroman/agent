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
import { assertNoStrayFields } from "./_stray-fields.ts";
import { DEFAULT_GREETING } from "./agent-defaults.ts";
import {
  assertPipelineTuning,
  assertProviderTriple,
  assertSamplingScope,
  assertSilencePolicy,
} from "./config-rules.ts";
import { MCP_SERVER_KEY_RE } from "./mcp-config.ts";
import { defaultProviders } from "./providers/_default-providers.ts";
import { assertAssemblyAITtsLanguage } from "./providers/tts/assemblyai.ts";
import { formatSchemaIssues } from "./standard-schema.ts";
import { DEFAULT_SYSTEM_PROMPT } from "./system-prompt.ts";
import { BuiltinToolSchema, ToolChoiceSchema } from "./type-schemas.ts";
import type { Message } from "./types.ts";

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
  options?: ExecuteToolOptions,
) => Promise<string>;

// ─── AgentConfig ────────────────────────────────────────────────────────────

/**
 * Provider descriptor — a `{ kind, options }` pair produced by factories
 * like `assemblyAIStt(...)` / `anthropicLlm(...)` / `cartesiaTts(...)`. Kept
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
 * A name a person and a URL can both carry.
 *
 * `.min(1)` alone accepted `"   "`, which reaches the browser as the agent's
 * displayed name and the platform as a slug with nothing in it — a value that
 * is wrong everywhere it lands and is a mistake nowhere else.
 */
const AgentName = z
  .string()
  .min(1)
  .refine((name) => name.trim() !== "", { error: "name must not be blank" });

/**
 * The NAME of a variable, which is all `requiredEnv` ever holds.
 *
 * An entry that is blank, or that carries a space or an `=`, is not a variable
 * name any environment can hold — so a deploy's preflight would check for
 * something that cannot be set, and report the agent as missing it forever.
 * (A duplicate entry is left alone: it asks for the same check twice, which is
 * redundant rather than unsatisfiable.)
 */
const EnvVarName = z.string().refine((name) => name.trim() !== "" && !/[\s=]/.test(name), {
  error: "requiredEnv holds VARIABLE NAMES — this one has no name a variable could have",
});

/**
 * One declared MCP server, on the wire.
 *
 * `.strict()` because this is the one config object whose keys name a REMOTE
 * system: a misspelled `tokenEnv` would otherwise deploy a server that silently
 * connects unauthenticated, and the 401 arrives per session rather than at the
 * boundary that could name the key.
 *
 * `tokenEnv` reuses {@link EnvVarName} rather than restating the rule — it is
 * the same claim `requiredEnv` makes, that the string is a variable NAME, and a
 * second copy is how the two come to disagree about what a name may hold.
 */
const McpServerConfigSchema = z
  .object({
    url: z.url().refine(
      (value) => {
        // `URL.parse` rather than `new URL`: zod runs every check and collects
        // the issues, so a refinement here still sees a value `z.url()` already
        // rejected — and a constructor THROWS out of the parse, turning a
        // "that is not a URL" into an unhandled TypeError several layers up.
        const protocol = URL.parse(value)?.protocol;
        return protocol === "http:" || protocol === "https:";
      },
      {
        error:
          "an MCP server URL must be http(s) — stdio and other transports are not supported (see sdk/mcp-config.ts)",
      },
    ),
    tokenEnv: EnvVarName.optional(),
    // The reviewed tool baseline: remote tool name → fingerprint. Opaque here
    // on purpose — the digest is `fingerprintTools`' to define, and a shape
    // rule restated in this schema is one that can disagree with it.
    pinnedTools: z.record(z.string().min(1), z.string().min(1)).optional(),
  })
  .strict();

/**
 * The `mcpServers` record, keyed by {@link MCP_SERVER_KEY_RE}.
 *
 * The key is checked HERE, at the config boundary, rather than when the client
 * connects: it becomes part of the tool name the model is shown, so a key a
 * provider would reject has to fail where the author can still see their own
 * `agent.ts` — not per session, in a vendor message naming neither.
 */
const McpServersSchema = z.record(
  z.string().regex(MCP_SERVER_KEY_RE, {
    error:
      'an mcpServers key becomes part of the tool name the model calls: lowercase, starting with a letter, words joined by "_", at most 24 characters',
  }),
  McpServerConfigSchema,
);

/**
 * Zod schema for {@link AgentConfig} — the JSON-safe subset of the agent
 * definition, transmitted between worker and host via structured clone.
 *
 * @internal
 */
export const AgentConfigSchema = z.object({
  name: AgentName,
  // Defaulted rather than required: `agent()` fills these in, but a raw
  // `export default {...}` agent.ts (no `agent()` wrapper) reaches
  // `toAgentConfig` without them — the old mapper shipped a config with
  // `greeting: undefined` (typed `string`, silently invalid) for such agents.
  systemPrompt: z.string().default(DEFAULT_SYSTEM_PROMPT),
  greeting: z.string().default(DEFAULT_GREETING),
  sttPrompt: z.string().optional(),
  maxSteps: z.number().int().positive().optional(),
  // Sampling temperature for the agent's OWN model calls (pipeline and text
  // modes). `assertSamplingScope` rejects it for s2s rather than dropping it.
  temperature: z.number().min(0).max(2).optional(),
  toolChoice: ToolChoiceSchema.optional(),
  builtinTools: z.array(BuiltinToolSchema).readonly().optional(),
  idleTimeoutMs: z.number().nonnegative().optional(),
  silenceTimeoutMs: z.number().positive().optional(),
  silencePrompt: z.string().optional(),
  minBargeInWords: z.number().int().min(1).optional(),
  interruptionMinDurationMs: z.number().int().nonnegative().optional(),
  deadAirCoverMs: z.number().int().nonnegative().optional(),
  errorPhrase: z.string().optional(),
  startFailurePhrase: z.string().optional(),
  resumeFalseInterruption: z.boolean().optional(),
  preemptiveGeneration: z.boolean().optional(),
  stt: ProviderDescriptorSchema.optional(),
  llm: ProviderDescriptorSchema.optional(),
  tts: ProviderDescriptorSchema.optional(),
  s2s: ProviderDescriptorSchema.optional(),
  // `z.literal(true)`, not `z.boolean()`: `text: false` would be a second
  // spelling of "not a text agent", and the field is a mode SELECTOR — the
  // one thing a mode selector must not have is two ways to say the same
  // thing, one of which a stale config can carry.
  text: z.literal(true).optional(),
  mode: z.enum(["s2s", "pipeline", "text"]).optional(),
  requiredEnv: z.array(EnvVarName).readonly().optional(),
  /**
   * MCP servers whose tools join the agent's own. Serializable, like every
   * other declaration here: the runtime that connects may be in a guest
   * sandbox, so the record has to survive CLI → server → runtime like `stt`
   * does. The `mcp-config.ts` doc carries what the shape is and is not.
   */
  mcpServers: McpServersSchema.optional(),
  // Serializable rather than host-only: it is a DECLARATION about the agent's
  // surface, exactly like `name` and `greeting`, and every consumer of a
  // serialized config wants it — the browser (does this page open a mic?), the
  // CLI's build, the studio's preview. The `workflows` record beside it is
  // host-only for the opposite reason: those are functions.
  page: z.enum(["voice", "static"]).optional(),
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
 *
 * It cannot catch a SUPERFLUOUS entry, which is the other direction and the one
 * that went stale: `state` sat here after `AgentDef.state` was deleted with the
 * `ctx.state` bag, denying a key nothing produces and telling every reader the
 * bag still exists. An entry here is a claim that `AgentDef` has that field.
 */
export const HOST_ONLY_AGENT_FIELDS = [
  "tools",
  "syncState",
  "workflows",
  // Handlers are functions, same as `workflows` — and unlike `page`, nothing
  // downstream of the wire has any use for knowing an agent observes itself.
  "events",
] as const;

/** A host-only `AgentDef` field name stripped by `toAgentConfig` (`tools`, `events`, …). */
export type HostOnlyAgentField = (typeof HOST_ONLY_AGENT_FIELDS)[number];

const HOST_ONLY_FIELD_SET: ReadonlySet<string> = new Set(HOST_ONLY_AGENT_FIELDS);

/**
 * Every key an authored agent may carry: the serializable config fields plus
 * the host-only ones the deny-list strips. DERIVED from the schema rather than
 * listed, so a new field is known here the moment it is declared there — a
 * hand-kept copy would reject the field on the branch that adds it.
 */
export const KNOWN_AGENT_FIELDS: ReadonlySet<string> = new Set([
  ...Object.keys(AgentConfigSchema.shape),
  ...HOST_ONLY_AGENT_FIELDS,
]);

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
  // BEFORE the cross-field rules, so a misspelled field is reported as itself
  // rather than as whatever rule notices its absence three checks later.
  assertNoStrayFields(src, KNOWN_AGENT_FIELDS);
  // After the fill, `assertProviderTriple` classifies the mode (and still
  // rejects s2s combined with pipeline stages) so the server can trust it.
  const mode = assertProviderTriple(src.stt, src.llm, src.tts, src.s2s, src.text);
  assertSilencePolicy(mode, src.silenceTimeoutMs, src.silencePrompt);
  assertPipelineTuning(mode, src);
  assertSamplingScope(mode, src.temperature);
  // Runs inside the generated bundle entry too, so the studio's test_agent
  // surfaces a bad TTS language as a load error rather than shipping a mute agent.
  assertAssemblyAITtsLanguage(src.tts);

  // Deny-list copy: everything defined flows through unless it is host-only.
  // The allow-list mapper this replaces is how fields went missing silently —
  // every field is optional, so an omitted copy is valid TypeScript
  // (which is how fields have gone missing silently before).
  const wire: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(src)) {
    if (value === undefined || HOST_ONLY_FIELD_SET.has(key)) continue;
    wire[key] = value;
  }
  // AFTER the copy, never before it. `mode` is DERIVED — `AgentConfigSource`
  // omits it precisely so a typed caller cannot supply one — but the copy is a
  // deny-list over `Object.entries`, so a `mode` on a raw object (a hand-written
  // `export default {...}`, a config round-tripped through the wire) would
  // otherwise overwrite the value `assertProviderTriple` just classified. The
  // deploy boundary rejects the disagreement (`IsolateConfigSchema.superRefine`),
  // so the symptom was a confusing deploy failure rather than a wrong session —
  // but the schema is second-guessing a value this function is the authority on.
  wire.mode = mode;
  // safeParse, then a SENTENCE. The schema re-validates field shapes, copies
  // arrays (the config must not alias caller-owned arrays), and strips any key
  // it does not know — a second net under the deny-list for non-serializable
  // strays. What changed is the failure: a `ZodError`'s own `message` is the
  // JSON dump of its issues, and this function runs inside the generated bundle
  // entry, so `agent({ maxSteps: 0 })` reached an author as a twelve-line
  // `[{ "origin": "number", "code": "too_small", … }]` at `aai build`. Every
  // other authoring mistake in this SDK answers with a sentence naming the
  // field; a config-SHAPE mistake, which is the most common class there is, was
  // the one that did not.
  const parsed = AgentConfigSchema.safeParse(wire);
  if (!parsed.success) {
    throw new Error(
      `This agent's configuration is invalid — ${formatSchemaIssues(parsed.error.issues)}`,
    );
  }
  return parsed.data;
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
