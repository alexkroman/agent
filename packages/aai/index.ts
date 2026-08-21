// Copyright 2025 the AAI authors. MIT license.
/**
 * The AAI voice-agent SDK — the AUTHORING surface, and only that.
 *
 * What an `agent.ts` imports: `agent()` and `tool()`, `sessionSlot()` and
 * `workflow()`, the types they take and return, the recommended
 * `assemblyAIPipeline()` preset, the `assemblyAIS2s()` opt-in, and the
 * `DEFAULT_*` constants that document an `agent()` field's default.
 *
 * Provider factories live on subpaths: `@alexkroman1/aai/stt`,
 * `@alexkroman1/aai/llm`, and `@alexkroman1/aai/tts` (pipeline mode). See
 * also `@alexkroman1/aai/utils` for zod-free helpers usable in tool code, and
 * `@alexkroman1/aai/testing` for `createToolContext()`.
 *
 * **The modules below are re-exported by NAME, not by `export *`, and that is
 * the point of this file.** Two of them — `sdk/constants.ts` and
 * `sdk/utils.ts` — are the repo's shared modules, so a wildcard put every
 * framework budget and platform contract in an agent author's autocomplete:
 * 175 exports, of which the fourteen templates and the scaffold between them
 * used eleven. Everything subtracted here is still exported somewhere it
 * belongs — `@alexkroman1/aai/internal` for cross-package infrastructure,
 * `@alexkroman1/aai/utils` for the zod-free helpers and the slug/CLI contracts
 * the platform and the CLI both derive.
 *
 * The rule for adding to this file: a symbol earns a place here if an
 * `agent.ts`, a tool module, or a `workflow()` would name it. A budget the
 * framework enforces on its own does not qualify, however public it is.
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
export * from "./sdk/flow.ts";
export * from "./sdk/generate.ts";
/**
 * The other machine: one unit of WORK inside a tool call, where a flow is where
 * a CONVERSATION is. On the root beside it because an author reaching for one
 * needs to see the other to pick correctly.
 */
export * from "./sdk/graph.ts";
// The one preset that belongs next to `agent()` rather than behind a provider
// subpath: it IS the recommended configuration, and requiring three more
// imports to reach it is what made the wrong mode the easy one.
export * from "./sdk/providers/assemblyai-pipeline.ts";
// S2S is opt-in now that the pipeline is the default mode, so the opt-in
// descriptor lives next to `agent()` too.
export * from "./sdk/providers/s2s/assemblyai.ts";
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
 * `sdk/utils.ts` is also where the slug contract (`VALID_SLUG_RE`,
 * `RESERVED_SLUGS`, …), the `aai login` confirmation code, and the framework's
 * own wire helpers live, because it is the module the CLI can import without
 * paying for zod. None of those is authoring API; they stay on
 * `@alexkroman1/aai/utils`, which is where the CLI and the platform read them.
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
// `workflow()` and everything a caller of `ctx.workflows` reads. On the ROOT
// barrel rather than a subpath because declaring a workflow sits beside
// declaring a tool — an author writes both in `agent.ts`. The engine behind it
// (the Workflow DevKit) is not re-exported from anywhere here: an author imports
// `sleep`, `defineHook` and the directives from `workflow` directly, which keeps
// this SDK from having to track that package's surface.
export * from "./sdk/workflow.ts";
