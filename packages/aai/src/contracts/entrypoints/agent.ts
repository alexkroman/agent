// Copyright 2025 the AAI authors. MIT license.
/**
 * Capability contract: `agent`.
 *
 * Declaring an agent: the `agent()` and `workflowApp()` helpers, the parameter
 * unions that make a mode mistake a compile error, and the shape a declaration
 * resolves to.
 *
 * **Three families that used to be here are capabilities of their own now**,
 * because each moves for a reason unrelated to declaring an agent and every
 * move renumbered this, the flagship contract every template imports:
 *
 * - the session EVENT vocabulary and the `events` handler types — `events`.
 *   `AgentObservation` still names `SessionEventHandlers`, so adding or dropping
 *   the field is visible here; a new EVENT is not.
 * - the pipeline turn-taking field group, `PipelineVoiceTuning` and
 *   `UserTurnLimit` — `turn-taking`. `AgentDef` still extends the group by name.
 * - personas — `persona`, which already owned the roster.
 *
 * `SessionEventContext` stays: it is the twin of `AgentSessionContext`, below.
 *
 * `ProviderCredentialOptions` is here for the same reason as
 * `ProviderDescriptor`: every provider options interface on all four stages
 * extends it, so no one stage owns it and the root is the narrowest place it
 * fits. It is what lets a descriptor repoint its own credential — the field the
 * host has always read off ANY descriptor generically, and which until now only
 * the four AssemblyAI options types could spell.
 *
 * The two telephony types are here rather than on a capability of their own —
 * `aai-runtime` has one by that name — because what they type is a FIELD of an
 * agent declaration. `AgentDef.telephony` is what mounts `WS /phone`, so a
 * change to the carrier vocabulary changes what declaring an agent looks like,
 * which is exactly what this capability covers. The codecs that serve the
 * declaration are the other package's business and are contracted there.
 *
 * `ProviderDescriptor` is here because it is the only one of the five
 * descriptor types with no stage of its own: `AgentDef` names all four stages,
 * and the base they narrow used to be re-exported from every stage subpath —
 * one interface with four reference pages, a name four capabilities each
 * half-owned. The four stage types themselves stay with their stages, which
 * publish the factories that produce them.
 *
 * The six `Mcp*` names are here for the same reason `AgentDef` is: `mcpServers`
 * is a field of an agent declaration, so its shape, the grammar of a server
 * key, and the rule turning a server's tool name into the one the model calls
 * are all part of what declaring an agent looks like. The CLIENT that reads
 * them is `withMcpTools` on `@alexkroman1/aai-runtime` and belongs to that
 * package's own `tools` capability — this SDK opens no sockets.
 *
 * **The FIELD-GROUP interfaces are here.** `AgentDef` is declared as an
 * extension of them — `AgentModelTuning`, `AgentGuardrails` and
 * `AgentObservation` (the voice tuning is `turn-taking`'s, above) — each a
 * set of `AgentDef` fields split out of `types.ts` so one shared validation rule could be argued once where it applies. That split is an
 * organization of the declaration, not a second surface: an author writes
 * `agent({ temperature })` and `agent({ outputGuardrails })` in the same object
 * literal they write `agent({ name })` in, so a signature change in any of them
 * is a change to what declaring an agent looks like. `UsageLimits` rides with
 * `AgentModelTuning` because it is the type of one of its fields and has no
 * reader anywhere else. `ModelTuning` — the per-request half `AgentModelTuning`
 * extends — is here with it rather than on `subagent`, though `SubagentDef`
 * extends it too: it is declared beside `AgentModelTuning`, and one capability
 * owning it is the whole point of it being one declaration.
 *
 * `AgentGuardrails` is worth one more sentence, because `subagent` also
 * contracts a guardrail: `GuardrailVerdict` is one vocabulary shared by both and
 * is contracted THERE, where `SubagentGuardrail` declares it. What is here is
 * the AGENT-level pair of fields, the same way `subagent`'s own contract note
 * puts the `AgentDef.subagents` field's signature on this capability rather than
 * on its own.
 *
 * `AgentSystemPrompt` and `AgentInstructions` are the type of `systemPrompt`
 * after it widened from `string` — the union and the resolver arm. Contracted
 * here and not on a capability of their own: `systemPrompt` is the field an
 * `agent()` declaration cannot omit, and a resolver is a way of writing it
 * rather than a separate thing to write.
 *
 * `AgentSessionContext` is the one real choice among these, and it lands here
 * because of what it is the context OF: the three `agent()` fields that are
 * callbacks rather than values (`systemPrompt` as a resolver, and the two
 * guardrail arrays), all three of them contracted above. It is declared to be
 * the same shape as `SessionEventContext` and to carry the same omissions —
 * no `send`, no `generate`, no `messages` — and `SessionEventContext` is
 * already on this contract, so splitting the twins across two capabilities
 * would let one move without bumping the other, which is the exact drift the
 * two modules warn each other against. It is NOT `state`'s, though it carries a
 * `SlotStore`: `state` owns what a slot IS, and a context that hands one to an
 * author is a field of the agent declaration, the same way `ToolContext.slots`
 * does not make `ToolContext` part of `state`.
 *
 * **The three voice-preset names are here for the field-group reason above**,
 * with one addition. `AgentVoicePresets` is the fifth interface `AgentDef`
 * extends and `VoicePresetName` is the vocabulary its one field takes, so both
 * are plainly part of what declaring an agent looks like. `VOICE_PRESETS` is
 * the judgement call: it is TEXT, like `DEFAULT_SYSTEM_PROMPT` on `defaults`,
 * and it lands here rather than there because a preset is not a default —
 * nothing gets it by omission, it is the set of values the `voicePresets` field
 * accepts, and its keys and that field's type are one union. What `defaults`
 * covers is what an agent that declares NOTHING is given.
 *
 * `workflowApp()` belongs here rather than in `workflow`: it declares an AGENT
 * (returning `AgentDef`, like `agent()`), and what it selects is a front door.
 * The `workflow` capability is the runs themselves — `workflow()`, and what a
 * caller of `ctx.workflows` reads.
 *
 * Re-exported from `@alexkroman1/aai`. This file is not shipped and nothing
 * imports it — it exists so `pnpm check:api-contracts` can extract a report
 * for this capability alone, hash it, and hold it to a committed epoch. See
 * `scripts/api-contracts.mjs`.
 */

export {
  type AgentDef,
  type AgentGuardrail,
  type AgentGuardrails,
  type AgentInstructions,
  type AgentModelTuning,
  type AgentObservation,
  type AgentParams,
  type AgentSessionContext,
  type AgentSystemPrompt,
  type AgentVoicePresets,
  type AssemblyAIPipelineOptions,
  agent,
  assemblyAIPipeline,
  type BuiltinTool,
  MCP_SERVER_KEY_RE,
  MCP_TOOL_NAME_MAX,
  MCP_TOOL_PREFIX,
  type McpServerConfig,
  type McpServers,
  type ModelTuning,
  mcpToolName,
  type PipelineAgentParams,
  type ProviderCredentialOptions,
  type ProviderDescriptor,
  type S2sAgentParams,
  type SessionEventContext,
  type SharedAgentParams,
  type StaticAgentParams,
  type TelephonyAccess,
  type TelephonyCarrier,
  type TextAgentParams,
  type ToolChoice,
  type TurnDetectionMode,
  type UsageLimits,
  VOICE_PRESETS,
  type VoicePresetName,
  workflowApp,
} from "../../index.ts";
