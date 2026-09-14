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
import { VOICE_PRESET_NAMES } from "./voice-presets.ts";

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

/**
 * @internal Zod schema for `VoicePresetName`, DERIVED from the tuple that is
 * also the emit order — the one list, so a fifth preset cannot reach the prompt
 * while the wire schema rejects it.
 */
export const VoicePresetNameSchema = z.enum(VOICE_PRESET_NAMES);

/** @internal Zod schema for `ToolChoice`. Exported for reuse in internal schemas. */
export const ToolChoiceSchema = z.union([
  z.enum(["auto", "required", "none"]),
  z.object({ type: z.literal("tool"), toolName: z.string().min(1) }),
]);
