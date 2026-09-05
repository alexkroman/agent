// Copyright 2026 the AAI authors. MIT license.
/**
 * What a dialog state's `meta` CARRIES, and how it is read back.
 *
 * A state node's `meta` was one string — the `instruction` a refusal quotes —
 * and reading it was four lines in `_dialog-snapshot.ts`. It carries a voice
 * call's per-phase settings now (a deadline, a TTS voice, a barge-in policy,
 * STT keyterms, the two model knobs), and every one of them is read back by the
 * SAME rule from the SAME place, so the rule and the field list belong in one
 * module rather than repeated per getter.
 *
 * ## `meta` is the only place a per-state setting can live
 *
 * XState carries `meta` through `getPersistedSnapshot`/`createActor({ snapshot
 * })` untouched — it is part of the machine DEFINITION, not of the snapshot, so
 * it costs the stored value nothing and cannot go stale against a resumed
 * session. That is why the settings go here rather than into a table beside the
 * machine: `getMeta()` on a live snapshot answers for exactly the states the
 * dialog is in, parents included, which is the question every reader here asks.
 *
 * The price is that `meta` is typed `Record<string, any>` by XState unless a
 * machine declares `types: {} as { meta: … }`, which is precisely the silent
 * failure {@link DialogStateSpec} was introduced to close: a misspelled
 * `instructions` compiled, deployed, and produced refusals with no recovery
 * text. So every reader below VALIDATES the value it finds rather than trusting
 * it — on the machine form there is nothing else standing between a typo and a
 * setting that silently does not exist.
 *
 * ## Deepest active state wins, and it does not MERGE
 *
 * `getMeta()` is keyed `"<machineId>.<statePath>"` for every ACTIVE node, so a
 * nested state's entry and its parent's both appear and the deepest key is the
 * longest one. Whichever node declares the field DEEPEST supplies it, and a
 * parent contributes nothing to it — the rule `toInstruction` has always used,
 * for the reason it states: a merge would let a parent's general guidance
 * override the specific state the caller is actually in.
 *
 * {@link toVoiceConfig} applies that per DECLARATION rather than per field: the
 * deepest state that declares ANY voice knob supplies the whole config. A phase
 * that pins `voice` and `bargeIn` together means them together — a per-field
 * merge would hand a disclosure state its parent's interruptible barge-in while
 * honouring its own voice, which is the half-applied policy this is here to
 * avoid.
 *
 * Internal (`_`-prefixed, per the repo's file-naming rules): nothing outside
 * this package may import it. `dialog()` is the public surface.
 */

import type {
  DialogBargeIn,
  DialogStateSpec,
  DialogTimeout,
  DialogTimeoutSpec,
  DialogVoiceConfig,
} from "./dialog-types.ts";
import { isRecord } from "./is-record.ts";
import { omitUndefined } from "./omit-undefined.ts";
import type { ToolChoice } from "./tool-def.ts";

/**
 * The `meta` a {@link DialogStateSpec} state compiles to, or `undefined` when
 * it declares nothing.
 *
 * The wrapper is applied ONCE, here — `meta.instruction` is what
 * {@link toInstruction} reads back, and the whole reason the spec form exists is
 * that XState cannot type that key. `undefined` rather than an empty object so a
 * state declaring none of these carries no `meta` at all, which is what keeps
 * the compiled machine (and so `getMeta()`, and so every reader here)
 * byte-identical to what a spec with no settings produced before they existed.
 */
export function toStateMeta(state: DialogStateSpec): Record<string, unknown> | undefined {
  const meta = omitUndefined({
    instruction: state.instruction,
    timeout: state.timeout,
    voice: state.voice,
    bargeIn: state.bargeIn,
    keyterms: state.keyterms,
    toolChoice: state.toolChoice,
    temperature: state.temperature,
  });
  return Object.keys(meta).length === 0 ? undefined : meta;
}

/**
 * The deepest active state's declaration of one setting.
 *
 * `read` is handed each active node's own `meta` record and answers `undefined`
 * for "this node does not declare it", which is what makes the depth rule apply
 * to the DECLARING node rather than to the deepest node overall: a leaf with no
 * `voice` does not shadow the parent that set one.
 *
 * Ties keep the LAST entry seen. `getMeta()` has one key per active node and no
 * two of them are the same length unless they are in different parallel
 * regions, where either answer is as good as the other and neither is a merge.
 */
function deepest<T>(
  meta: Record<string, unknown>,
  read: (declared: Record<string, unknown>) => T | undefined,
): T | undefined {
  let deepestKey = "";
  let found: T | undefined;
  for (const [key, value] of Object.entries(meta)) {
    if (!isRecord(value)) continue;
    const declared = read(value);
    if (declared === undefined || key.length < deepestKey.length) continue;
    deepestKey = key;
    found = declared;
  }
  return found;
}

/**
 * The active state's declared instruction, from the DEEPEST node that has one.
 *
 * Moved here from `_dialog-snapshot.ts` when the other two readers were written
 * — all three answer the same question of the same object, and one of them
 * should not be able to change its depth rule while the others keep the old one.
 */
export function toInstruction(meta: Record<string, unknown>): string | undefined {
  return deepest(meta, (declared) =>
    typeof declared.instruction === "string" ? declared.instruction : undefined,
  );
}

/**
 * One state's declared deadline, validated — the raw `meta.timeout` read.
 *
 * Exported because the DECLARATION check needs it too: `_dialog-events.ts` reads
 * each state node's own `meta` to verify that `send` names an event something
 * can actually handle, and a second copy of "what counts as a timeout" is how
 * the check and the reader come to disagree about which states have one.
 *
 * `afterMs` must be finite and positive: `0` and `NaN` both read as "no
 * deadline" to every plausible consumer, and a negative one is a deadline that
 * has already passed, so accepting any of them would put a runtime in the
 * position of inventing the meaning.
 */
export function declaredTimeout(declared: Record<string, unknown>): DialogTimeoutSpec | undefined {
  const timeout = declared.timeout;
  if (!isRecord(timeout)) return undefined;
  const { afterMs, send } = timeout;
  if (typeof afterMs !== "number" || !Number.isFinite(afterMs) || afterMs <= 0) return undefined;
  return typeof send === "string" && send !== "" ? { afterMs, send } : undefined;
}

/**
 * The deadline in force where the dialog is now, as the event it would send.
 *
 * The event is built here rather than by the caller so that the one place that
 * knows `timeout.send` is an event NAME is the one place that turns it into an
 * event OBJECT — a runtime arming this deadline sends it back through
 * {@link Dialog.send} and never has to know that spelling.
 */
export function toTimeout(meta: Record<string, unknown>): DialogTimeout | undefined {
  const declared = deepest(meta, declaredTimeout);
  return declared === undefined
    ? undefined
    : { afterMs: declared.afterMs, event: { type: declared.send } };
}

/** `"default"`, `"off"`, or the two-number form — anything else is not one. */
function toBargeIn(value: unknown): DialogBargeIn | undefined {
  if (value === "default" || value === "off") return value;
  if (!isRecord(value)) return undefined;
  const { minWords, minDurationMs } = value;
  return omitUndefined({
    minWords: typeof minWords === "number" ? minWords : undefined,
    minDurationMs: typeof minDurationMs === "number" ? minDurationMs : undefined,
  });
}

/** A keyterm list, or nothing — a partly-string array is a typo, not a list. */
function toKeyterms(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every((term) => typeof term === "string") ? [...value] : undefined;
}

/** See {@link ToolChoice}: three names, or the one-tool form. */
function toToolChoice(value: unknown): ToolChoice | undefined {
  if (value === "auto" || value === "required" || value === "none") return value;
  if (!isRecord(value) || value.type !== "tool") return undefined;
  return typeof value.toolName === "string"
    ? { type: "tool", toolName: value.toolName }
    : undefined;
}

/** One state's voice knobs, or `undefined` when it declares none of them. */
function declaredVoiceConfig(declared: Record<string, unknown>): DialogVoiceConfig | undefined {
  const config = omitUndefined({
    voice: typeof declared.voice === "string" ? declared.voice : undefined,
    bargeIn: toBargeIn(declared.bargeIn),
    keyterms: toKeyterms(declared.keyterms),
    toolChoice: toToolChoice(declared.toolChoice),
    temperature: typeof declared.temperature === "number" ? declared.temperature : undefined,
  });
  return Object.keys(config).length === 0 ? undefined : config;
}

/**
 * The voice settings in force where the dialog is now — see the module doc for
 * why this is deepest-DECLARATION rather than a per-field merge.
 */
export function toVoiceConfig(meta: Record<string, unknown>): DialogVoiceConfig | undefined {
  return deepest(meta, declaredVoiceConfig);
}
