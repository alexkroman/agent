// Copyright 2026 the AAI authors. MIT license.
/**
 * Reading a {@link ToolDef}'s input schema and handler under either spelling.
 *
 * `tool()` and `workflow()` differ by one word now — `input` and `run` on both —
 * and the old names (`inputSchema`, `execute`) are accepted for one major. That
 * leaves every CONSUMER with two places to look, which is exactly the shape that
 * produces a silently half-migrated field: one reader updated, another still on
 * the old name, and a tool that validates against no schema or cannot be called.
 * So no consumer reads either field directly — they go through `toolInput` /
 * `toolRun` here, and `tool()` collapses a def to the canonical spelling at the
 * one place every authored tool passes through.
 *
 * @internal
 */

import type { ToolInputSchema } from "./schema.ts";
import type { ToolDef, ToolHandler } from "./types.ts";

/** The tool's input schema under either spelling, or `undefined` if it takes none. */
export function toolInput<P extends ToolInputSchema, S>(
  def: Readonly<ToolDef<P, S>>,
): P | undefined {
  return def.input ?? def.inputSchema;
}

/**
 * The tool's handler under either spelling.
 *
 * Returns `undefined` for a def carrying neither, which `tool()` rejects at
 * authoring time — but a raw `export default {…}` agent skips `tool()`, so every
 * call site has to answer for the absent case rather than assume it away.
 */
export function toolRun<P extends ToolInputSchema, S>(
  def: Readonly<ToolDef<P, S>>,
): ToolHandler<P, S> | undefined {
  return def.run ?? def.execute;
}
