// Copyright 2026 the AAI authors. MIT license.
/**
 * Which of a dialog's five per-state voice knobs this runtime can actually
 * apply — the DECLARATION check, and the translation of the three that survive.
 *
 * `pipeline-dialog-knobs.ts` carries the table of where each knob is fixed and
 * why two of them cannot vary within a session. This module is the half an
 * AUTHOR meets: it walks every declared dialog's machine once, warns for each
 * state that declares a knob nothing applies, and answers whether any state
 * declares one that something does.
 *
 * ## It warns rather than throws, and the choice is about WHEN it runs
 *
 * `dialog()` already refuses a defect it can see for itself — an `after` a
 * dialog can never fire, a `when` naming no state — at declaration, which on a
 * deployed agent is module load. This check cannot live there: whether `voice`
 * can take effect is a property of the TRANSPORT, and the SDK does not know
 * which one a session will run on. So the earliest moment it can run is the
 * first session, which is a caller already on the line — and hanging up on them
 * over a knob that merely does nothing is a worse outcome than the knob doing
 * nothing. It is reported once per runtime (see {@link reported}), at warn
 * level, naming the dialog, the state and the knob, so the line appears in a
 * deployment's own logs on its first call rather than once per event.
 *
 * When a transport gains the ability — the AssemblyAI S2S service takes both
 * `voice` and `keyterms` in `session.update`, so it is the plausible next one —
 * the knob moves out of {@link INERT_KNOBS} and the warning stops.
 */

import type { AnyDialog, DialogVoiceConfig, SlotHolder } from "@alexkroman1/aai";
import { isRecord, omitUndefined } from "@alexkroman1/aai/utils";
import type { AnyStateMachine } from "xstate";
import type { Logger } from "./runtime-config.ts";
import type { DialogTurnKnobs } from "./transports/pipeline-dialog-knobs.ts";

/**
 * The knobs a declared state may carry that nothing in this runtime applies.
 *
 * Both are fixed when the provider stream OPENS: the TTS voice rides on the
 * descriptor that produced the opener, and `SttOpenOptions` has no keyterms
 * field at all. Changing either mid-call means closing the socket and dialling
 * a new one, which on the TTS side is a gap in the agent's own sentence.
 */
const INERT_KNOBS = ["voice", "keyterms"] as const;

/** The knobs a declared state may carry that the pipeline DOES apply per state. */
const LIVE_KNOBS = ["bargeIn", "toolChoice", "temperature"] as const;

/**
 * Runtimes whose dialogs have already been reported.
 *
 * Keyed by the ARRAY, which is `agent.dialogs` — one object per agent
 * definition, so the warning is paid once per deployed agent rather than once
 * per session. Weak so a rebuilt runtime (`aai dev` rebuilds one per file save)
 * does not pin the previous build's definition.
 */
const reported = new WeakSet<readonly AnyDialog[]>();

/** Every state node under a machine's root, and the root itself. */
function nodesOf(machine: AnyStateMachine): readonly AnyStateMachine["root"][] {
  const out: AnyStateMachine["root"][] = [machine.root];
  const walk = (node: AnyStateMachine["root"]): void => {
    for (const child of Object.values(node.states)) {
      out.push(child);
      walk(child);
    }
  };
  walk(machine.root);
  return out;
}

/**
 * One state's own `meta`, or undefined when it declares none.
 *
 * XState types `meta` as `Record<string, any>` unless a machine declares
 * `types: {} as { meta: … }`, and no dialog does — which is the whole reason
 * `DialogStateSpec` exists. So it is read as `unknown` and guarded, exactly as
 * `_dialog-meta.ts` reads it on the other side of the package boundary.
 */
function metaOf(node: AnyStateMachine["root"]): Record<string, unknown> | undefined {
  const meta: unknown = node.meta;
  return isRecord(meta) ? meta : undefined;
}

/** Why a per-state value for this knob cannot take effect, in the author's terms. */
function inertReason(knob: (typeof INERT_KNOBS)[number]): string {
  return knob === "voice"
    ? "the TTS voice is fixed by the provider descriptor when the stream opens, and re-opening it mid-call would cut the agent's own sentence in half. Set it once with `agent({ voice })`"
    : "the pipeline's STT stream takes no keyterms at all — only the AssemblyAI S2S service does, and only in its opening session config. Use `agent({ sttPrompt })`, which every transport forwards";
}

/**
 * Warn for every inert knob, and report whether any LIVE one is declared.
 *
 * The return value is what gates the transport seam: `false` means no state
 * anywhere asks for a barge-in, tool-choice or temperature change, so the
 * pipeline is built exactly as it was before dialogs existed — no per-turn
 * thunks in the barge-in gates, no preparer in front of every step, and
 * preemptive generation left on if the agent asked for it.
 *
 * @internal
 */
export function reportDialogKnobs(dialogs: readonly AnyDialog[], logger: Logger): boolean {
  const first = !reported.has(dialogs);
  reported.add(dialogs);
  let live = false;
  for (const dialog of dialogs) {
    for (const node of nodesOf(dialog.machine)) {
      const meta = metaOf(node);
      if (meta === undefined) continue;
      if (LIVE_KNOBS.some((knob) => meta[knob] !== undefined)) live = true;
      if (first) warnInertKnobs(dialog.key, node.path.join("."), meta, logger);
    }
  }
  return live;
}

/** One state's warnings, one line per inert knob it declares. */
function warnInertKnobs(
  key: string,
  path: string,
  meta: Record<string, unknown>,
  logger: Logger,
): void {
  for (const knob of INERT_KNOBS) {
    if (meta[knob] === undefined) continue;
    logger.warn(
      `Dialog "${key}" declares \`${knob}\` on state "${path}", and nothing applies it: ${inertReason(knob)}. The state's other settings are unaffected.`,
    );
  }
}

/**
 * `bargeIn` in the two numbers the pipeline's gates actually read.
 *
 * `"off"` becomes an UNREACHABLE word threshold rather than a third flag, and
 * that is not a trick: both gates are `words >= threshold` tests, so an infinite
 * threshold is precisely "no interim and no final ever cuts the agent off" —
 * which is what a disclosure state means by it. The word COUNT is still
 * computed and still drives the speaking edge and the live caption, so a caller
 * who talks over a disclosure is still transcribed and still answered once the
 * agent finishes.
 */
function fromBargeIn(bargeIn: DialogVoiceConfig["bargeIn"]): DialogTurnKnobs {
  if (bargeIn === undefined || bargeIn === "default") return {};
  if (bargeIn === "off") return { minBargeInWords: Number.POSITIVE_INFINITY };
  return omitUndefined({
    minBargeInWords: bargeIn.minWords,
    interruptionMinDurationMs: bargeIn.minDurationMs,
  });
}

/**
 * Fold the active states' voice configs into one set of turn knobs — LAST
 * declaration wins, per key.
 *
 * The merge rule is per KEY here where `toVoiceConfig` is per DECLARATION inside
 * one dialog, and the two are answering different questions. Within a dialog the
 * states are NESTED, so a phase that pins a voice and a barge-in together means
 * them together and a per-field merge would hand a disclosure state its parent's
 * interruptible barge-in. Two dialogs have no containment relation at all —
 * neither is a special case of the other — so there is no "together" to
 * preserve, and per-key is the only merge with a meaning. Last writer wins is
 * the rule `composePrepareStep` already uses one layer down.
 *
 * `undefined` when nothing is declared, which is the common case on a call:
 * most states carry an instruction and no knobs, and the transport's thunks
 * then fall straight through to the agent's own settings.
 *
 * @internal
 */
export function mergeTurnKnobs(
  dialogs: readonly AnyDialog[],
  ctx: SlotHolder,
): DialogTurnKnobs | undefined {
  let merged: DialogTurnKnobs | undefined;
  for (const dialog of dialogs) {
    const config = dialog.voiceConfig(ctx);
    if (config === undefined) continue;
    merged = {
      ...merged,
      ...fromBargeIn(config.bargeIn),
      // `voice` and `keyterms` are deliberately not read: nothing applies them,
      // and `reportDialogKnobs` has already said so where an author can see it.
      ...omitUndefined({ toolChoice: config.toolChoice, temperature: config.temperature }),
    };
  }
  return merged;
}
