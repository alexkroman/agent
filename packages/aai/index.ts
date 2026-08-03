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
 */

// biome-ignore-all lint/performance/noReExportAll: barrel file by design

export * from "./sdk/constants.ts";
export * from "./sdk/db.ts";
export * from "./sdk/define.ts";
export * from "./sdk/env-types.ts";
export * from "./sdk/epoch.ts";
export * from "./sdk/generate.ts";
export * from "./sdk/owned-map.ts";
// The one preset that belongs next to `agent()` rather than behind a provider
// subpath: it IS the recommended configuration, and requiring three more
// imports to reach it is what made the wrong mode the easy one.
export * from "./sdk/providers/assemblyai-pipeline.ts";
// S2S is opt-in now that the pipeline is the default mode, so the opt-in
// descriptor lives next to `agent()` too.
export * from "./sdk/providers/s2s/assemblyai.ts";
export * from "./sdk/types.ts";
export * from "./sdk/utils.ts";
export * from "./sdk/ws-upgrade.ts";
