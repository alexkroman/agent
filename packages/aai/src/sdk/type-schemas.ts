// Copyright 2026 the AAI authors. MIT license.
/**
 * Zod mirrors of the small union types in `types.ts`.
 *
 * Split out because `types.ts` is types-only otherwise, and it sat 4 lines
 * under the source-file cap — every field added to `AgentDef` had to argue
 * with the line limit. `types.ts` re-exports these, so importers are
 * unaffected; `schema-alignment.test.ts` asserts each stays in step with the
 * TypeScript union it mirrors.
 */

import { z } from "zod";
import { MAX_ENDPOINTING_RULE_TIMEOUT_MS } from "./endpointing-rules.ts";

/**
 * A `RegExp` source string that actually compiles.
 *
 * Checked HERE rather than left to the matcher, because the matcher runs
 * inside the STT partial handler where a throw escapes into a provider
 * callback — so it swallows a bad pattern and the rule silently never fires.
 * This is the boundary that can still name the field: `toAgentConfig` runs at
 * build time and the deploy boundary re-runs it, so a typo'd pattern is an
 * error the author sees rather than a rule that does nothing on a call.
 */
const RegexSource = z.string().min(1).superRefine(refineRegexSource);

function refineRegexSource(source: string, ctx: z.RefinementCtx): void {
  try {
    new RegExp(source);
  } catch (err) {
    ctx.addIssue({
      code: "custom",
      message: `not a valid regular expression: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

/** `flags` accepted on an endpointing rule — the `RegExp` flag alphabet. */
const RegexFlags = z.string().regex(/^[dgimsuvy]*$/, "invalid RegExp flags");

const EndpointingTimeout = z.number().int().positive().max(MAX_ENDPOINTING_RULE_TIMEOUT_MS);

/**
 * @internal Zod schema for `EndpointingRule`. A discriminated union on `type`,
 * so an unknown kind is rejected by name rather than silently matching
 * nothing.
 */
export const EndpointingRuleSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("assistant"),
    regex: RegexSource,
    flags: RegexFlags.optional(),
    timeoutMs: EndpointingTimeout,
  }),
  z.object({
    type: z.literal("user"),
    regex: RegexSource,
    flags: RegexFlags.optional(),
    timeoutMs: EndpointingTimeout,
  }),
  z.object({
    type: z.literal("both"),
    assistantRegex: RegexSource,
    userRegex: RegexSource,
    flags: RegexFlags.optional(),
    timeoutMs: EndpointingTimeout,
  }),
]);

/** @internal Zod schema for `BuiltinTool`. Exported for reuse in internal schemas. */
export const BuiltinToolSchema = z.enum([
  "web_search",
  "visit_webpage",
  "get_page_design",
  "fetch_json",
  "run_code",
  "think",
  "remember",
  "recall",
  "calculate",
]);

/** @internal Zod schema for `ToolChoice`. Exported for reuse in internal schemas. */
export const ToolChoiceSchema = z.union([
  z.enum(["auto", "required", "none"]),
  z.object({ type: z.literal("tool"), toolName: z.string().min(1) }),
]);
