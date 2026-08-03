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
