// Copyright 2026 the AAI authors. MIT license.
/**
 * Normalization of the author-only conveniences `AgentParams` allows on top
 * of `AgentDef` — `system` as an alias of `systemPrompt`, and a model-id
 * string for `llm`. Used by `agent()` and, for configs that never went
 * through `agent()` (a raw `export default {...}` object), by
 * `parseManifest` and `toAgentConfig`, so the conveniences work on every
 * authoring path rather than only the documented one.
 *
 * An `_`-internal module (not on the root barrel): this is plumbing between
 * `define.ts` and the two parse boundaries, not API.
 */

import { normalizeLlm } from "./providers/llm/from-string.ts";

/**
 * Returns a NEW object (never mutates); non-objects pass through untouched
 * so schema validation still owns the "not an agent config at all" error.
 */
export function normalizeAgentConveniences(input: unknown): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
  const { system, ...rest } = input as { system?: unknown; [key: string]: unknown };
  if (typeof system === "string") {
    if (rest.systemPrompt !== undefined) {
      throw new Error("`system` and `systemPrompt` are aliases — set one, not both.");
    }
    rest.systemPrompt = system;
  }
  if (typeof rest.llm === "string") rest.llm = normalizeLlm(rest.llm);
  return rest;
}
