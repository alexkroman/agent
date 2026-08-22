// Copyright 2025 the AAI authors. MIT license.
/**
 * The AAI voice-agent SDK — the AUTHORING surface, and only that.
 *
 * What an `agent.ts` imports: `agent()` and `tool()`, `sessionSlot()` and
 * `workflow()`, the types they take and return, the recommended
 * `assemblyAIPipeline()` preset, the `assemblyAIS2s()` opt-in, and the
 * `DEFAULT_*` constants that document an `agent()` field's default.
 *
 * A symbol is on this barrel when an `agent.ts`, a tool module, or a
 * `workflow()` would NAME it. Everything else the package publishes is on a
 * subpath, chosen by WHO READS IT:
 *
 * | Subpath | Reach for it when |
 * | --- | --- |
 * | `@alexkroman1/aai/testing`, `/testing/vitest` | testing your own tools — `createToolContext`, `withDiscoveredTools`, `runTool` |
 * | `@alexkroman1/aai/stt`, `/llm`, `/tts`, `/s2s` | picking a provider for a pipeline stage |
 * | `@alexkroman1/aai/step`, `/step-errors` | writing a `"use step"` body inside a workflow |
 * | `@alexkroman1/aai/workflow-api` | calling a deployed agent from a page, a script or a cron job |
 * | `@alexkroman1/aai/tools` | calling `fetchJson`/`webSearch`/`visitWebpage` from your own tool code |
 * | `@alexkroman1/aai/utils` | small helpers written inside a tool body |
 * | `@alexkroman1/aai/ffmpeg` | running ffmpeg from a step |
 * | `@alexkroman1/aai-runtime` | self-hosting the Node runtime |
 * | `@alexkroman1/aai/protocol`, `/manifest`, `/internal` | framework internals; not covered by semver |
 *
 * Three primitives here run a defined process, and they are not
 * interchangeable. A `dialog()` gates a CONVERSATION — what the agent may say
 * or do next, across turns. A `procedure()` runs ONE UNIT OF WORK inside a
 * single tool call. A `workflow()` runs DURABLY, outliving the session.
 *
 * @module
 */

// biome-ignore-all lint/performance/noReExportAll: barrel file by design

/**
 * The constants that document an `agent()` field's default, or a limit a tool
 * author writes against.
 *
 * Everything else in `sdk/constants.ts` is a framework budget — jitter-buffer
 * depths, provider connect deadlines, wire caps, WebSocket close codes — and
 * lives on `@alexkroman1/aai/internal`. The test for membership is whether an
 * author could act on the value: `DEFAULT_MIN_BARGE_IN_WORDS` documents
 * `minBargeInWords`, while `PLAYBACK_FILL_MS` documents a decision the
 * client audio path makes with no field to set.
 */
export {
  DEFAULT_BUILTIN_TOOLS,
  DEFAULT_ERROR_PHRASE,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_INTERRUPTION_MIN_DURATION_MS,
  DEFAULT_MAX_HISTORY,
  DEFAULT_MAX_STEPS,
  DEFAULT_MAX_TURN_SILENCE_MS,
  DEFAULT_MIN_BARGE_IN_WORDS,
  DEFAULT_MIN_TURN_SILENCE_MS,
  DEFAULT_SILENCE_PROMPT,
  DEFAULT_START_FAILURE_PHRASE,
  DEFAULT_STT_PROMPT,
  DEFAULT_TOOL_CHOICE,
  MAX_CLIENT_EVENT_NAME_LENGTH,
  MAX_CLIENT_EVENT_PAYLOAD_BYTES,
  MAX_TOOL_RESULT_CHARS,
  TOOL_EXECUTION_TIMEOUT_MS,
  TOOL_RESULT_TRUNCATION_MARKER,
} from "./sdk/constants.ts";
export * from "./sdk/db.ts";
// `agent()` / `tool()` and the three-arm `AgentParams` union behind them.
export * from "./sdk/define.ts";
/**
 * The dialog statechart — next to `agent()`/`tool()` because it is how a guided
 * agent declares what it may do NEXT, which is authoring rather than an
 * optional utility. Its machine comes from `xstate`, which an author imports
 * directly; nothing here re-exports it.
 */
export * from "./sdk/dialog.ts";
export * from "./sdk/generate.ts";
/**
 * The other machine: one unit of WORK inside a tool call, where a flow is where
 * a CONVERSATION is. On the root beside it because an author reaching for one
 * needs to see the other to pick correctly.
 */
export * from "./sdk/procedure.ts";
// The one preset that belongs next to `agent()` rather than behind a provider
// subpath: it IS the recommended configuration, and requiring three more
// imports to reach it is what made the wrong mode the easy one.
export * from "./sdk/providers/assemblyai-pipeline.ts";
/**
 * S2S is opt-in now that the pipeline is the default mode, so the opt-in
 * descriptor lives next to `agent()` too.
 *
 * By NAME rather than `export *`: that module also exports
 * `ASSEMBLYAI_S2S_KIND` and `ASSEMBLYAI_S2S_API_KEY_ENV`, which an `agent.ts`
 * never writes — the descriptor sets the kind, and credentials resolve
 * server-side. They live on `@alexkroman1/aai/s2s` beside the eleven
 * `*_KIND`/`*_API_KEY_ENV` pairs of the other provider modules.
 */
export {
  type AssemblyAIS2sOptions,
  type AssemblyAIS2sProvider,
  assemblyAIS2s,
} from "./sdk/providers/s2s/assemblyai.ts";
/**
 * Standard Schema acceptance — the two an author names.
 *
 * `StandardSchemaV1` and its result/issue types are the ecosystem SPEC that
 * `tool()` happens to accept, not something an agent declares; they stay in
 * `sdk/schema.ts` for the signatures that reference them.
 */
export type { InferSchemaOutput, ToolInputSchema } from "./sdk/schema.ts";
/**
 * The types an `agent({ events })` handler is written against.
 *
 * On the root by the barrel's own membership test — an `agent.ts` NAMES these the
 * moment a handler is extracted from the literal into a function of its own, which
 * is the first thing an author does once one grows past a line. `SessionEvent`
 * itself is not here: it is the wire union and lives on
 * `@alexkroman1/aai/protocol`, so a handler that needs to name one imports it
 * there, exactly as a client does.
 */
export type {
  SessionEventContext,
  SessionEventHandler,
  SessionEventHandlers,
  SessionEventType,
} from "./sdk/session-events.ts";
// Session state's typed seam — next to `agent()`/`tool()` because it is how a
// multi-file agent reads and writes its own state, not an optional utility.
export * from "./sdk/session-slot.ts";
/**
 * The two names a slot's own signatures mention, and only those.
 *
 * By NAME rather than `export *`: that module also holds the storability check
 * and the detached store, which are `@internal` — and an `@internal` name on a
 * public subpath is what `check:api-contracts` refuses, correctly, since it would
 * sit in an author's autocomplete beside `sessionSlot`.
 */
export type { SlotStore, StateProjection } from "./sdk/session-state.ts";
// Resolving what a caller SAID to one of the things a tool holds — the
// never-guess contract, on the root barrel because it is written in a tool body
// beside `toolFailure`, which it returns.
export * from "./sdk/spoken.ts";
export * from "./sdk/types.ts";
/**
 * The utilities written INSIDE a tool body.
 *
 * The module behind them also holds the platform's slug contract, the
 * `aai login` confirmation code, and the framework's own wire helpers, because
 * it is the one the CLI can import without paying for zod. None of those is
 * authoring API; they stay on `@alexkroman1/aai/utils`, which is where the CLI
 * and the platform read them.
 */
export {
  createKeyedLock,
  errorDetail,
  errorMessage,
  isToolFailure,
  type KeyedLock,
  type KeyedLockOptions,
  KeyedLockTimeoutError,
  pushCapped,
  safeJsonParse,
  type ToolFailure,
  toolFailure,
  withLock,
} from "./sdk/utils.ts";
/**
 * DECLARING a workflow — and only that.
 *
 * `workflow()` is on the root barrel because declaring one sits beside declaring
 * a tool: an author writes both in `agent.ts`. Everything about the RUN it
 * starts — the option bags, the snapshot union, its guard, `WorkflowOutputOf`,
 * the wait cap — is on `@alexkroman1/aai/workflow-api`, whose reader is a page,
 * a script, or a tool annotating a result. Seventeen names, none of which an
 * `agent.ts` ever writes, and the barrel's membership test is exactly that.
 *
 * `WorkflowClient` stays because `ToolContext.workflows` names it.
 *
 * The engine behind all of it (the Workflow DevKit) is not re-exported from
 * anywhere here: an author imports `sleep`, `defineHook` and the directives from
 * `workflow` directly, which keeps this SDK from having to track that package's
 * surface.
 */
export { type WorkflowClient, type WorkflowDef, workflow } from "./sdk/workflow.ts";
