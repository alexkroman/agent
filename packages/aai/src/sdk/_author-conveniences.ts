// Copyright 2026 the AAI authors. MIT license.
/**
 * Normalization of what an author WRITES into the canonical `AgentDef` shape:
 * the mode, the field legality that follows from it, and the author-only
 * conveniences.
 *
 * In order, because each step reads what the one before it settled:
 *
 * 1. **The mode** (`resolveAgentMode`, `_agent-modes.ts`) — `mode`, or the
 *    pipeline default, written onto the definition.
 * 2. **Field legality** (`assertModeFields`) — every field the mode's member
 *    does not have, refused by name. Against the AUTHORED fields, so
 *    `turnTaking` on an S2S agent is reported as `turnTaking`.
 * 3. **The conveniences** — a model-id string for `llm`, and
 *    `turnTaking.minSilenceMs`/`maxSilenceMs` lowered onto the same two
 *    options of `assemblyAIStt()`. A TTS voice has no shorthand: it is the
 *    descriptor's option (`assemblyAITts({ voice })`), so it has one owner.
 *
 * **There is no `system` alias.** `agent({ system: "…" })` reaches
 * `assertNoStrayFields` and is refused BY NAME, which is the better error: two
 * spellings of one field is a precedence rule somebody has to remember.
 *
 * Used by `agent()` and, for configs that never went through `agent()` (a raw
 * `export default {...}` object), by `toAgentConfig` — and idempotent, because
 * `toAgentConfig` also sees `agent()`'s own output.
 *
 * An `_`-internal module (not on the root barrel): plumbing between
 * `define.ts` and the config boundary, not API.
 */

import { assertModeFields, resolveAgentMode } from "./_agent-modes.ts";
import { assertTurnSilenceWindow, ENDPOINTING_KEYS } from "./config-rules.ts";
import { isRecord } from "./is-record.ts";
import { omitUndefined } from "./omit-undefined.ts";
import { normalizeLlm } from "./providers/llm/shared/from-string.ts";
import { assemblyAIStt } from "./providers/stt/assemblyai.ts";

/**
 * Returns a NEW object (never mutates); non-objects pass through untouched
 * so schema validation still owns the "not an agent config at all" error.
 */
export function normalizeAgentParams(input: unknown): unknown {
  if (!isRecord(input)) return input;
  const rest: Record<string, unknown> = { ...input };
  const mode = resolveAgentMode(rest);
  assertModeFields(mode, rest);
  rest.mode = mode;
  if (typeof rest.llm === "string") rest.llm = normalizeLlm(rest.llm);
  assertSyncStateRecord(rest.syncState);
  normalizeEndpointing(rest);
  // AFTER the desugaring, and over `rest.stt` rather than over the two
  // shorthands: the same contradiction is expressible on an explicit
  // `assemblyAIStt({ … })` descriptor, and by the time the shorthand has been
  // lowered onto one there is a single shape to check.
  assertTurnSilenceWindow(rest.stt);
  return rest;
}

/**
 * `turnTaking: { minSilenceMs, maxSilenceMs }` → the same two options on the
 * default AssemblyAI STT descriptor, in place; the group is COPIED, so a
 * caller's own object is never mutated.
 *
 * The lowering exists because these are the highest-value tuning an agent has
 * and were the highest-friction to express: reaching `maxTurnSilenceMs` used to
 * mean materializing a whole `assemblyAIStt({ … })` descriptor — which then
 * silently opted the stage out of the default fill. One number should not cost
 * a stage. Lowered rather than carried on `AgentDef` so there is ONE owner of
 * the value at runtime — `resolveAssemblyAISttSettings`.
 */
function normalizeEndpointing(rest: Record<string, unknown>): void {
  if (!isRecord(rest.turnTaking)) return;
  const turnTaking: Record<string, unknown> = { ...rest.turnTaking };
  const min = takeNumber(turnTaking, "minSilenceMs");
  const max = takeNumber(turnTaking, "maxSilenceMs");
  if (min === undefined && max === undefined) return;
  if (Object.keys(turnTaking).length === 0) delete rest.turnTaking;
  else rest.turnTaking = turnTaking;
  const [minKey, maxKey] = ENDPOINTING_KEYS;
  if (rest.stt !== undefined) {
    throw new Error(
      "`turnTaking.minSilenceMs`/`maxSilenceMs` tune the default AssemblyAI STT stage — an " +
        "explicit `stt` descriptor owns its own end-of-turn window; set it there " +
        `(e.g. \`assemblyAIStt({ ${maxKey} })\`), or remove \`stt\`.`,
    );
  }
  rest.stt = assemblyAIStt(omitUndefined({ [minKey]: min, [maxKey]: max }));
}

/** Read a numeric field off a group and REMOVE it, so `AgentDef` stays canonical. */
function takeNumber(group: Record<string, unknown>, key: string): number | undefined {
  const value = group[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number") {
    throw new Error(`\`turnTaking.${key}\` must be a number of milliseconds.`);
  }
  delete group[key];
  return value;
}

/**
 * `syncState` is a record keyed by SLOT NAME, and each key must be its
 * projection's own slot key — the browser selects by that name, so a key that
 * disagrees with the slot it projects would publish one name and render
 * another. A bare projection or an array (the forms the record replaced) is
 * refused with the spelling to write instead.
 */
function assertSyncStateRecord(syncState: unknown): void {
  if (syncState === undefined) return;
  const isProjection = (value: unknown): value is { key: unknown } =>
    typeof value === "function" && "key" in value;
  if (isProjection(syncState) || Array.isArray(syncState)) {
    const sample = isProjection(syncState) ? String(syncState.key) : "cart";
    throw new Error(
      `\`syncState\` takes a record keyed by slot name — write \`syncState: { ${sample}: ${sample}Slot.projected }\`, one entry per slot.`,
    );
  }
  if (!isRecord(syncState)) {
    throw new Error("`syncState` takes a record keyed by slot name, of slot projections.");
  }
  for (const [name, projection] of Object.entries(syncState)) {
    if (!isProjection(projection)) {
      throw new Error(`\`syncState.${name}\` is not a slot projection (use \`slot.projected\`).`);
    }
    if (projection.key !== name) {
      throw new Error(
        `\`syncState.${name}\` projects the "${String(projection.key)}" slot — key it by that slot's name: \`${String(projection.key)}: …\`.`,
      );
    }
  }
}
