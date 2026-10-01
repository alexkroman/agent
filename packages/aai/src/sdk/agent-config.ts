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

import { z } from "zod";
import { normalizeAgentParams } from "./_author-conveniences.ts";
import { assertNoStrayFields } from "./_stray-fields.ts";
import { InterruptionSchema, SilenceSchema, TurnTakingSchema } from "./_tuning-schema.ts";
import { DEFAULT_GREETING } from "./agent-defaults.ts";
import { type AgentSystemPrompt, staticSystemPrompt } from "./agent-instructions.ts";
import { AGENT_MODES, type AgentMode } from "./agent-mode.ts";
import { assertGuardrailScope, assertProviderTriple, assertSamplingScope } from "./config-rules.ts";
import { MCP_SERVER_KEY_RE, type McpServers } from "./mcp-config.ts";
import { defaultProviders } from "./providers/_default-providers.ts";
import { assertAssemblyAITtsLanguage } from "./providers/tts/assemblyai.ts";
import { formatSchemaIssues } from "./standard-schema.ts";
import { DEFAULT_SYSTEM_PROMPT } from "./system-prompt.ts";
import {
  BuiltinToolNameSchema,
  TelephonyCarrierNameSchema,
  ToolChoiceSchema,
  VoicePresetNameSchema,
} from "./type-schemas.ts";
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
 * like `assemblyAIStt(...)` / `llm({ provider: "anthropic", ... })` / `cartesiaTts(...)`. Kept
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
    // OPTIONAL on the wire, never in `agent.ts`: `McpServerConfig.url` is
    // required, and absent here means the author wrote a RESOLVER, which
    // `toAgentConfig` drops because only the runtime holding the agent's own
    // module can call it (see `wireMcpServers`).
    url: z
      .url()
      .refine(
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
      )
      .optional(),
    tokenEnv: EnvVarName.optional(),
    // Remote tool names, so opaque beyond "not blank": the server owns its
    // spelling, and `mcpToolName` is what maps it onto a legal model name.
    allowedTools: z.array(z.string().min(1)).readonly().optional(),
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
  /**
   * What the agent IS, for a reader of a LIST — see `AgentDef.description`.
   * Serializable because that reader is a registry, an A2A card or the studio's
   * picker, none of which runs the agent.
   */
  description: z.string().optional(),
  // Defaulted rather than required: `agent()` fills these in, but a raw
  // `export default {...}` agent.ts (no `agent()` wrapper) reaches
  // `toAgentConfig` without them — the old mapper shipped a config with
  // `greeting: undefined` (typed `string`, silently invalid) for such agents.
  systemPrompt: z.string().default(DEFAULT_SYSTEM_PROMPT),
  greeting: z.string().default(DEFAULT_GREETING),
  sttPrompt: z.string().optional(),
  maxSteps: z.number().int().positive().optional(),
  // The five `AgentModelTuning` knobs: this runtime assembles the request, so
  // `assertSamplingScope` rejects every one of them for s2s rather than
  // dropping it silently. Serializable — they are numbers and flags, and a
  // deployed guest has to carry them.
  temperature: z.number().min(0).max(2).optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  maxRetries: z.number().int().nonnegative().optional(),
  resetToolChoice: z.boolean().optional(),
  usageLimits: z.object({ totalTokens: z.number().int().positive().optional() }).optional(),
  toolChoice: ToolChoiceSchema.optional(),
  // OPEN, like `voicePresets` below: an unknown builtin is ACCEPTED (a newer
  // builtin still deploys on an older runtime, which resolves only the names it
  // ships and skips the rest) and WARNED about by `agentConfigWarnings`.
  builtinTools: z.array(BuiltinToolNameSchema).readonly().optional(),
  // Serializable like `builtinTools` beside it and for the same reason: it is a
  // DECLARATION of what the agent has switched on, the runtime that assembles
  // the prompt may be in a guest sandbox, and `buildSystemPrompt` reads it off
  // the config. An unknown name is ACCEPTED (the vocabulary is open, so a newer
  // preset still deploys on an older runtime) and WARNED about at build time by
  // `agentConfigWarnings` — a preset dropped without a word is the failure.
  voicePresets: z.array(VoicePresetNameSchema).readonly().optional(),
  idleTimeoutMs: z.number().nonnegative().optional(),
  // The pipeline's turn-taking tuning, as its three groups — see
  // `_tuning-schema.ts` for why each is `.strict()`.
  turnTaking: TurnTakingSchema.optional(),
  interruption: InterruptionSchema.optional(),
  silence: SilenceSchema.optional(),
  errorPhrase: z.string().optional(),
  startFailurePhrase: z.string().optional(),
  stt: ProviderDescriptorSchema.optional(),
  llm: ProviderDescriptorSchema.optional(),
  tts: ProviderDescriptorSchema.optional(),
  s2s: ProviderDescriptorSchema.optional(),
  // The AUTHORED mode, carried unchanged — the browser, the CLI, the studio and
  // a deploy all read the one field the author wrote. `toAgentConfig` always
  // writes it, having checked the providers agree with it.
  mode: z.enum(AGENT_MODES).optional(),
  requiredEnv: z.array(EnvVarName).readonly().optional(),
  /**
   * MCP servers whose tools join the agent's own. Serializable, like every
   * other declaration here: the runtime that connects may be in a guest
   * sandbox, so the record has to survive CLI → server → runtime like `stt`
   * does. The `mcp-config.ts` doc carries what the shape is and is not.
   */
  mcpServers: McpServersSchema.optional(),
  /**
   * Defaults for audio pushed to a device over `WS /inbox` — see
   * `AgentDef.clientInbox`. Serializable because the host that publishes the
   * default to `stepSayOnClient` may be a guest sandbox.
   */
  clientInbox: z
    .object({ sampleRate: z.number().int().min(8000).max(48_000).optional() })
    .optional(),
  /**
   * Which carriers may open a media stream against this agent — see
   * `AgentDef.telephony`. Serializable for the same reason `page` is: it is a
   * DECLARATION about the agent's surface rather than a function, so every
   * consumer of a stored config (the studio's preview, a deploy's validation)
   * can see which front doors this agent has without running it.
   *
   * The names are OPEN, like `voicePresets`: `TelephonyCarrier` accepts any
   * string so a carrier a later SDK ships still deploys on this one. A name
   * this build has no codec for is ACCEPTED, DROPPED by the runtime's
   * `enabledCarriers` (it mounts nothing, and the carriers this build knows
   * keep answering), and WARNED about at build time by `agentConfigWarnings`.
   */
  telephony: z.union([z.boolean(), z.array(TelephonyCarrierNameSchema).readonly()]).optional(),
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
  // A `SpeakerDef` may carry tool FUNCTIONS, so a roster cannot be serialized —
  // and nothing downstream of the wire needs it: its whole effect on the
  // deployed config is the toolset `agent()` minted, whose schemas travel with
  // every other tool's.
  "roster",
  // Toolsets hold defs and gates — functions — and their schemas already ride
  // the tool list.
  "toolsets",
  // A dialog holds a compiled XState machine and closures over a session slot.
  // Nothing downstream of the wire could act on one, and the guest runs the
  // agent's own module — where the dialog objects already are.
  "dialogs",
  // Handlers are functions, same as `workflows` — and unlike `page`, nothing
  // downstream of the wire has any use for knowing an agent observes itself.
  "events",
  // Guardrails are functions too. Nothing downstream of the wire could run one,
  // and the guest holds the agent's own module — which is the only side that
  // could have called them anyway.
  "inputGuardrails",
  "outputGuardrails",
  // The two session-bracketing hooks are functions too, and are called only by
  // the runtime holding the agent's own module — see `agent-session-lifecycle.ts`.
  "sessionContext",
  "onSessionEnd",
  // Route handlers are functions as well, served by the runtime holding the
  // agent's own module — see `agent-routes.ts`.
  "routes",
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
 * field plus the host-only fields the deny-list strips. `AgentDef` is assignable to this by
 * construction; the explicit `| undefined` on the host-only members keeps
 * spread call sites (`{...agent, stt: maybeUndefined}`) legal under
 * `exactOptionalPropertyTypes`.
 */
export type AgentConfigSource = Omit<AgentConfig, "mode" | "systemPrompt" | "mcpServers"> & {
  /**
   * Wider than the config's own `string`, because `AgentDef.systemPrompt`
   * may be a RESOLVER — a function this layer cannot serialize and must not
   * hand onward. Widened here rather than on {@link AgentConfig} so `AgentDef`
   * stays assignable to this by construction, which is what every
   * `toAgentConfig(agent)` call site relies on. `toAgentConfig` drops it (see
   * `staticSystemPrompt`); the runtime holds the agent's own module and asks
   * the function per request.
   */
  systemPrompt?: AgentSystemPrompt;
  /**
   * Wider than the wire's record for the same reason: an `McpServerConfig` may
   * carry a `url` RESOLVER and `headers`, both host-only. `toAgentConfig`
   * strips them (see `wireMcpServers`).
   */
  mcpServers?: McpServers | undefined;
  /** See `AgentDef.mode`; `undefined` from a spread means the default. */
  mode?: AgentMode | undefined;
} & {
  [K in HostOnlyAgentField]?: unknown;
};

/**
 * The `mcpServers` record as it may cross the wire: a `url` resolver and every
 * `headers` value dropped, everything else kept.
 *
 * `headers` goes in BOTH spellings, a literal record included, because a
 * header is where a credential lives (`x-api-key`), and a stored config is
 * read by more than the runtime that needs it. The runtime holds the agent's
 * own module, so it reads both from the definition rather than the wire.
 */
function wireMcpServers(servers: McpServers): Record<string, unknown> {
  const wire: Record<string, unknown> = {};
  for (const [key, server] of Object.entries(servers)) {
    const { url, headers: _headers, ...rest } = server;
    wire[key] = typeof url === "string" ? { url, ...rest } : rest;
  }
  return wire;
}

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
  // The same normalization `agent()` runs, so a raw `export default {...}` that
  // skipped `agent()` behaves the same: the mode and the fields it refuses,
  // a model-id string for `llm`, and the endpointing pair. Idempotent
  // over `agent()`'s own output. (There is no `system` alias — `agent({ system
  // })` is refused by name at the stray-field check below.)
  const normalized = normalizeAgentParams(source) as AgentConfigSource;
  const src = { ...normalized, ...(defaultProviders(normalized) ?? {}) };
  // BEFORE the cross-field rules, so a misspelled field is reported as itself
  // rather than as whatever rule notices its absence three checks later.
  assertNoStrayFields(src, KNOWN_AGENT_FIELDS);
  // After the fill, `assertProviderTriple` classifies the mode (and still
  // rejects s2s combined with pipeline stages) so the server can trust it.
  const mode = assertProviderTriple(
    src.stt,
    src.llm,
    src.tts,
    src.s2s,
    src.mode === "text" ? true : undefined,
  );
  assertSamplingScope(mode, src);
  assertGuardrailScope(mode, src);
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
  // A RESOLVER is host-only in a field that is otherwise serializable, which no
  // deny-list entry can express — the key belongs on the wire and only one of
  // its two shapes does. Dropped here rather than filtered above so the schema
  // still supplies `DEFAULT_SYSTEM_PROMPT` for it: what a resolver adds is
  // appended to the framework prompt exactly as a string would be, and the
  // runtime is the side that can call it. Without this the deny-list copy hands
  // `z.string()` a function, and the sentence an author gets names a field they
  // set correctly.
  if (staticSystemPrompt(src.systemPrompt) === undefined) delete wire.systemPrompt;
  // The same shape of problem one level down: an MCP server is serializable
  // except for its `url` resolver and its `headers`.
  if (src.mcpServers) wire.mcpServers = wireMcpServers(src.mcpServers);
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
