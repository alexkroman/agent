// Copyright 2025 the AAI authors. MIT license.
/**
 * The AAI voice-agent SDK.
 *
 * Exports `agent()` and `tool()` — the helpers an `agent.ts` file uses to
 * define a voice agent — plus the authoring types (`AgentDef`, `ToolDef`,
 * `ToolContext`, …), the recommended `assemblyAIPipeline()` preset, the
 * `assemblyAIS2s()` opt-in, and the `DEFAULT_*` constants documenting each
 * `agent()` field's default.
 *
 * Provider factories live on subpaths: `@alexkroman1/aai/stt`,
 * `@alexkroman1/aai/llm`, and `@alexkroman1/aai/tts` (pipeline mode). See
 * also `@alexkroman1/aai/utils` for zod-free helpers usable in tool code.
 * Infrastructure shared with the sibling packages lives on
 * `@alexkroman1/aai/internal` and is not part of the public API.
 *
 * **Every numeric default and budget is on `@alexkroman1/aai/limits`, and only
 * there.** They were re-exported here too and are no longer: 96 of them against
 * ~30 authoring names, so `agent`, `tool` and `workflow` were three entries in an
 * autocomplete list led by `MAX_CLIENT_WS_BUFFERED_BYTES`. A barrel whose job is
 * to be READ cannot also be the place every constant lives; `import { … } from
 * "@alexkroman1/aai/limits"` is the whole migration.
 *
 * Two exceptions stay, and they are exceptions because they are not budgets:
 * `DEFAULT_SYSTEM_PROMPT` and `DEFAULT_GREETING` are the TEXT `agent()` defaults
 * to, which an author reads in order to extend or replace it.
 */

// biome-ignore-all lint/performance/noReExportAll: barrel file by design

// `Db` and the two type-level things beside it. NOT `export *`: that module also
// holds `MAX_DB_RESULT_ROWS` (a budget — `/limits`) and
// `STORAGE_DISABLED_MESSAGE` (a thrown sentence nobody imports — `/internal`).
export type { Db } from "./sdk/db.ts";
export * from "./sdk/define.ts";
export * from "./sdk/generate.ts";
// The one preset that belongs next to `agent()` rather than behind a provider
// subpath: it IS the recommended configuration, and requiring three more
// imports to reach it is what made the wrong mode the easy one.
export * from "./sdk/providers/assemblyai-pipeline.ts";
// S2S is opt-in now that the pipeline is the default mode, so the opt-in
// descriptor lives next to `agent()` too.
export * from "./sdk/providers/s2s/assemblyai.ts";
// Schema acceptance (Standard Schema) — types only; the conversion helpers
// stay internal.
export type {
  InferSchemaOutput,
  StandardSchemaIssue,
  StandardSchemaResult,
  StandardSchemaV1,
  ToolInputSchema,
} from "./sdk/schema.ts";
// `ctx.state`'s typed seam — next to `agent()`/`tool()` because it is how a
// multi-file agent reads its own session state, not an optional utility.
export * from "./sdk/session-slot.ts";
export * from "./sdk/types.ts";
// The tool-code helpers. NOT `export *`: that module also re-exports the platform
// SLUG CONTRACT (`RESERVED_SLUGS`, `VALID_SLUG_RE`, `PREVIEW_SLUG_SUFFIX`,
// `MAX_SLUG_LENGTH`), whose documented home is `@alexkroman1/aai/utils` — the CLI
// and the platform read it there, and an agent author never reads it at all.
export {
  capToolResult,
  createKeyedLock,
  errorDetail,
  errorMessage,
  isTextAssetPath,
  isToolFailure,
  type KeyedLock,
  type KeyedLockOptions,
  KeyedLockTimeoutError,
  linkConfirmationCode,
  normalizeSpeechText,
  omitUndefined,
  pushCapped,
  safeJsonParse,
  type ToolFailure,
  toArgsRecord,
  toolError,
  withLock,
} from "./sdk/utils.ts";
// Durable workflows: `workflow()` sits next to `agent()`/`tool()` because it
// is the third thing an `agent.ts` declares, not a subsystem behind a subpath.
export * from "./sdk/workflow.ts";
// `startTool()` is beside them for the same reason — it is how a voice agent
// reaches a workflow, and its default correlation key is what makes the
// `workflow_status` builtin able to report the run.
export * from "./sdk/workflow-tool.ts";
