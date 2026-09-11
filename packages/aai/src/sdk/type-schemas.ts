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

/**
 * @internal Zod schema for `LowConfidencePolicy`.
 *
 * Both thresholds are bounded to 0..1 because that is the range a
 * recognizer's confidence lives in, and an out-of-range number here is
 * silently one of two different mistakes: `40` means "I thought this was a
 * percentage" (which would discard every turn) and `-1` means "I thought this
 * disabled it" (which would discard none). Neither fails at run time on its
 * own, so the schema is the only place either can be caught.
 */
export const LowConfidencePolicySchema = z.object({
  discardBelow: z.number().min(0).max(1).optional(),
  actionBelow: z.number().min(0).max(1).optional(),
  action: z.enum(["clarify", "note"]).optional(),
  phrase: z.string().optional(),
  note: z.string().optional(),
  statistic: z.enum(["mean", "minWord"]).optional(),
});
