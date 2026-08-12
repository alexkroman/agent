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
 * The numeric defaults and budgets are on `@alexkroman1/aai/limits`. They are
 * re-exported here as well, for now — see the note on that export below.
 */

// biome-ignore-all lint/performance/noReExportAll: barrel file by design

// The ~106 numeric defaults and budgets. Also published as
// `@alexkroman1/aai/limits`, which is the CANONICAL path: they are two thirds of
// this barrel's 133 names, and an authoring surface whose autocomplete is
// dominated by `MAX_CLIENT_WS_BUFFERED_BYTES` is one nobody can read. Kept here
// too because removing them is a breaking change for every consumer that reads
// one, so it belongs in a major rather than riding along with the new subpath.
export * from "./sdk/constants.ts";
export * from "./sdk/db.ts";
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
export * from "./sdk/utils.ts";
// Durable workflows: `workflow()` sits next to `agent()`/`tool()` because it
// is the third thing an `agent.ts` declares, not a subsystem behind a subpath.
export * from "./sdk/workflow.ts";
// `startTool()` is beside them for the same reason — it is how a voice agent
// reaches a workflow, and its default correlation key is what makes the
// `workflow_status` builtin able to report the run.
export * from "./sdk/workflow-tool.ts";
