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

/**
 * @internal The builtin names THIS release ships, as a closed enum — for the
 * readers that must know whether a name resolves (`isBuiltin` in
 * `testing-deployable.ts`, the build warning). NOT what the config schema
 * validates `builtinTools` with: `BuiltinTool` is open, so the schema is
 * {@link BuiltinToolNameSchema}.
 */
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
 * @internal Zod schema for a `builtinTools` entry — ANY non-empty string,
 * because `BuiltinTool` is an open vocabulary: a config naming a builtin a later
 * SDK ships must still deploy on this one. The runtime resolves only the names
 * it ships and skips the rest, and an unknown name is WARNED about at build
 * time (`agentConfigWarnings`), never refused here — the same treatment as
 * {@link VoicePresetNameSchema}.
 */
export const BuiltinToolNameSchema = z.string().min(1);

/**
 * @internal Zod schema for a `telephony` carrier entry — ANY non-empty string,
 * because `TelephonyCarrier` is open. The runtime serves only the carriers it
 * ships a codec for (`enabledCarriers` filters against `TELEPHONY_CARRIERS`),
 * so an unknown name mounts nothing, and it is WARNED about at build time
 * rather than refused.
 */
export const TelephonyCarrierNameSchema = z.string().min(1);

/**
 * @internal Zod schema for `VoicePresetName` — ANY non-empty string, because
 * the name is an open vocabulary: a config naming a preset a later SDK ships
 * must still deploy on this one. An unknown name emits no text and is WARNED
 * about at build time (`agentConfigWarnings`), never refused here.
 */
export const VoicePresetNameSchema = z.string().min(1);

/** @internal Zod schema for `ToolChoice`. Exported for reuse in internal schemas. */
export const ToolChoiceSchema = z.union([
  z.enum(["auto", "required", "none"]),
  z.object({ type: z.literal("tool"), toolName: z.string().min(1) }),
]);
