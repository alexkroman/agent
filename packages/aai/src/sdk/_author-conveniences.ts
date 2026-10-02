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
  if (rest.syncState !== undefined) rest.syncState = normalizeSyncState(rest.syncState);
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
 * `syncState` → the canonical record keyed by SLOT NAME, which is what the
 * `agent_state` frame and the browser select by.
 *
 * Accepts a projection or a list of them. Idempotent: the canonical record it
 * returns is accepted unchanged, since `toAgentConfig` also sees `agent()`'s
 * output — and each key must equal its projection's own slot key, since a key
 * that disagreed would publish one name and render another.
 */
function normalizeSyncState(syncState: unknown): Record<string, unknown> {
  const isProjection = (value: unknown): value is { key: unknown } =>
    typeof value === "function" && "key" in value;
  const sample =
    "`syncState: cartSlot.projected` or `syncState: [cartSlot.projected, prefsSlot.projected]`";
  if (isProjection(syncState)) return { [String(syncState.key)]: syncState };
  if (Array.isArray(syncState)) {
    const record: Record<string, unknown> = {};
    syncState.forEach((projection: unknown, index) => {
      if (!isProjection(projection)) {
        throw new Error(
          `\`syncState[${index}]\` is not a slot projection — pass a slot's \`.projected\` (declare the view with \`sessionSlot(key, create, { view })\`).`,
        );
      }
      const key = String(projection.key);
      if (key in record) {
        throw new Error(
          `\`syncState\` projects the "${key}" slot twice — a slot has ONE view on the wire; derive a second shape from it in the page.`,
        );
      }
      record[key] = projection;
    });
    return record;
  }
  if (!isRecord(syncState)) {
    throw new Error(`\`syncState\` takes a slot projection or a list of them — write ${sample}.`);
  }
  for (const [name, projection] of Object.entries(syncState)) {
    if (!isProjection(projection)) {
      throw new Error(`\`syncState.${name}\` is not a slot projection — write ${sample}.`);
    }
    if (projection.key !== name) {
      throw new Error(
        `\`syncState.${name}\` projects the "${String(projection.key)}" slot — pass the projection itself (\`syncState: [${String(projection.key)}Slot.projected]\`), which needs no key.`,
      );
    }
  }
  return syncState;
}
