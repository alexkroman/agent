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
 * 4. **The collected `syncState`** — the slots declared `sync: true` that no
 *    earlier def claimed, keyed by slot name ({@link resolveSyncState}).
 *
 * **There is no `system` alias and no `description` alias.** Each reaches
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

import { assertModeFields, isAgentMode, resolveAgentMode } from "./_agent-modes.ts";
import { claimUnsyncedProjections } from "./_sync-registry.ts";
import type { AgentMode } from "./agent-mode.ts";
import { assertTurnSilenceWindow, ENDPOINTING_KEYS } from "./config-rules.ts";
import { isRecord } from "./is-record.ts";
import { omitUndefined } from "./omit-undefined.ts";
import { stageMembers } from "./providers/fallback.ts";
import { normalizeLlm } from "./providers/llm/shared/from-string.ts";
import { assemblyAIStt } from "./providers/stt/assemblyai.ts";
import type { StateProjection } from "./session-state.ts";

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
  const syncState = resolveSyncState(rest.syncState, mode);
  if (syncState !== undefined) rest.syncState = syncState;
  normalizeEndpointing(rest);
  // AFTER the desugaring, and over `rest.stt` rather than over the two
  // shorthands: the same contradiction is expressible on an explicit
  // `assemblyAIStt({ … })` descriptor, and by the time the shorthand has been
  // lowered onto one there is a single shape to check.
  for (const member of stageMembers(rest.stt)) assertTurnSilenceWindow(member);
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
 * The canonical `syncState`: the record a def already holds, extended with the
 * slots registered `sync: true` that no other def has claimed (see
 * `SessionSlotOptions.sync`, and "An entry is CLAIMED" in
 * `_sync-registry.ts`). Nobody authors the field — `agent()` refuses the key —
 * so what arrives here is either nothing or a record an earlier pass of this
 * function produced, keyed by slot name.
 *
 * Resolved here rather than in `agent()` alone so a raw `export default {...}`
 * config in the same bundle syncs the same slots — and idempotent, because
 * the record this produces is accepted unchanged by the next pass. A record an
 * EARLIER pass collected is EXTENDED rather than kept: `agent()` runs before
 * the `tools/*.ts` modules the generated entry imports after `agent.ts`, so a
 * slot synced in one of those registers after the agent was built, and the
 * next pass is where every module has evaluated ("A collected `syncState` is
 * re-collected at the lowering" in `_sync-registry.ts`). A record built by
 * ANOTHER copy of the SDK — the bundle's def crossing into the host's
 * `toAgentConfig` — meets an empty registry and is validated and kept.
 *
 * A workflow app syncs nothing: it opens no session. It still CLAIMS what is
 * registered and unclaimed, and warns once naming the slots left out: an
 * unclaimed projection is collected by the NEXT def built in the process, so a
 * `sync: true` slot in a workflow app's module graph used to reach the voice
 * agent declared after it (a template suite, a monorepo spec).
 */
function resolveSyncState(
  declared: unknown,
  mode: AgentMode | undefined,
): Record<string, unknown> | undefined {
  if (mode === "workflow-app") {
    warnUnsyncedSlots(claimUnsyncedProjections(), "a workflow app, which opens no session");
    return undefined;
  }
  const record = declared === undefined ? undefined : assertSyncStateRecord(declared);
  const fresh = claimUnsyncedProjections();
  if (fresh.length === 0) return record;
  return keyedBySlot([...(record === undefined ? [] : Object.values(record)), ...fresh]);
}

/** The sentences already printed — one line per set of slots, not one per pass. */
const warnedUnsynced = new Set<string>();

/**
 * Say which `sync: true` slots a def is NOT syncing, once per sentence.
 * `console.warn` through `globalThis` for `_prompt-duplicate-warning.ts`'s
 * reason: this module runs in a browser bundle too, so no Node logger.
 */
function warnUnsyncedSlots(left: readonly StateProjection[], where: string): void {
  if (left.length === 0) return;
  const one = left.length === 1;
  const names = left.map((projection) => `"${projection.key}"`).join(", ");
  const line = [
    one ? "The slot" : "The slots",
    names,
    "declared `sync: true` but",
    one ? "sits" : "sit",
    `in ${where}, so`,
    one ? "it is" : "they are",
    "not synced to the page. Drop `sync: true`, or add the projection to `syncState`.",
  ].join(" ");
  if (warnedUnsynced.has(line)) return;
  warnedUnsynced.add(line);
  (globalThis as { console?: { warn?: (...args: unknown[]) => void } }).console?.warn?.(
    `[aai] ${line}`,
  );
}

/**
 * `def` with its `syncState` re-collected — the lowering step `withTools` runs
 * after every module has evaluated; see {@link resolveSyncState}. A def that
 * has nothing new to collect is handed back as it is (a workflow app always
 * is, after claiming and warning about what the modules loaded since `agent()`
 * ran registered `sync: true` — a tools file's slot).
 */
export function withCollectedSyncState<D extends object>(def: D): D {
  const { syncState: declared, mode } = def as {
    readonly syncState?: unknown;
    readonly mode?: unknown;
  };
  const syncState = resolveSyncState(declared, isAgentMode(mode) ? mode : undefined);
  if (syncState === undefined || syncState === declared) return def;
  return { ...def, syncState };
}

const isProjection = (value: unknown): value is { key: unknown } =>
  typeof value === "function" && "key" in value;

/** The remedy every `syncState` refusal names. */
const SYNC_REMEDY =
  "`syncState` is not authored — declare the slot `sessionSlot(key, create, { view, sync: true })` and `agent()` collects it.";

/**
 * The canonical record keyed by SLOT NAME, which is what the `agent_state`
 * frame and the browser select by. Each key must equal its projection's own
 * slot key, since a key that disagreed would publish one name and render
 * another; a slot twice is refused where the collision is named.
 */
function keyedBySlot(projections: readonly StateProjection[]): Record<string, StateProjection> {
  const record: Record<string, StateProjection> = {};
  for (const projection of projections) {
    const key = String(projection.key);
    if (key in record) {
      throw new Error(
        `\`syncState\` projects the "${key}" slot twice — a slot has ONE view on the wire; derive a second shape from it in the page.`,
      );
    }
    record[key] = projection;
  }
  return record;
}

/**
 * The record a `syncState` already on a def must be: projections keyed by
 * their own slot names. Anything else — a projection, a list, a hand-written
 * record under the wrong key — is the authored form `agent()` refuses, reaching
 * this boundary from a raw `export default {...}`.
 */
function assertSyncStateRecord(syncState: unknown): Record<string, StateProjection> {
  if (!isRecord(syncState)) throw new Error(SYNC_REMEDY);
  for (const [name, projection] of Object.entries(syncState)) {
    if (!isProjection(projection) || projection.key !== name) {
      throw new Error(`\`syncState.${name}\` is not that slot's own projection. ${SYNC_REMEDY}`);
    }
  }
  return syncState as Record<string, StateProjection>;
}
