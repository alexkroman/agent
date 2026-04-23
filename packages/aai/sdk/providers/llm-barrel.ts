// Copyright 2025 the AAI authors. MIT license.
/**
 * `@alexkroman1/aai/llm` subpath barrel.
 *
 * Re-exports LLM provider factories. Users import from here instead of
 * `@ai-sdk/anthropic` directly so the agent bundle stays free of eager
 * env reads and other SDK side-effects.
 */

export type { LlmProvider } from "../providers.ts";
// biome-ignore lint/performance/noReExportAll: subpath barrel
export * from "./llm/anthropic.ts";
