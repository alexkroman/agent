// Copyright 2026 the AAI authors. MIT license.
/**
 * One session's roster — its SPEAKING entries ("personas" here) — bound to the
 * two things a roster cannot reach from inside a tool call: the PROMPT and the
 * TRANSPORT.
 *
 * `roster()` gives an agent a slot and a gate: a speaking entry's tool refuses
 * while another one speaks, and `handoff` writes the slot. That
 * much works from any tool body on any transport with nothing wired. What a
 * handoff also owes, and what only a session can do, is:
 *
 * 1. **The active persona's instructions reach the MODEL every step.** They are
 *    a keyed suffix on the session's prompt (`SessionSystemPrompt.setSuffix`,
 *    the seam that was made keyed for exactly a second installer), rendered
 *    fresh at each request — so on the pipeline the step AFTER the handoff tool
 *    already runs under the new persona's section, in the same turn.
 * 2. **A service holding its instructions as session state is told.** OpenAI
 *    Realtime takes its prompt once in `session.update`, so a changed section
 *    has to be PUSHED; `Transport.refreshSystemPrompt` diffs and sends. The
 *    pipeline needs no push — it re-reads the thunk — and AssemblyAI S2S cannot
 *    take one, which is the limitation `transport.ts` documents for a
 *    dialog too.
 * 3. **The pipeline re-tunes per step.** The active persona's two model knobs
 *    reach `streamText` through a `prepareStep` preparer — see
 *    `transports/pipeline/knobs/persona.ts`, which also records why the tool
 *    set is deliberately NOT narrowed there.
 *
 * ## The key sorts BEFORE the dialogs', and that is the intended reading
 *
 * Suffixes render in key order (`localeCompare`), so `"active-persona"` lands
 * above `"dialogs"`: WHO is speaking, then WHERE in their script they are. The
 * order is asserted in this module's spec rather than trusted, because it is a
 * property of two string literals in two files.
 *
 * ## A persona can change on exactly two events
 *
 * A handoff is a slot write from a tool body, so it lands under a
 * `tool.completed`; a dialog's `persona` pin moves with the dialog, whose
 * commit emits `state.updated`. Those two are the only events this module
 * re-renders on. Rendering reads every bound dialog's position — an XState
 * actor started and stopped per dialog — which is far too much to do on every
 * transcript frame, and no other event can move the answer.
 *
 * The dialogs bridge pushes its OWN suffix on a move and only when its text
 * changed, so a move that changes the pinned persona but not the instruction
 * would push nothing; this module's own change check on `state.updated` is what
 * closes that.
 */

import type { Roster, SessionEvent, SlotHolder, SlotStore, SpeakerDef } from "@alexkroman1/aai";
import { errorMessage, omitUndefined } from "@alexkroman1/aai/utils";
import type { Logger } from "../logger.ts";
import type { PersonaTurnSource } from "../transports/pipeline/index.ts";
import { interruptionKnobs, type PersonaInterruptionSource } from "../transports/pipeline/index.ts";
import type { Transport } from "../transports/types.ts";
import type { SessionSystemPrompt } from "./system-prompt.ts";

/** The suffix key — sorts before the dialogs' `"dialogs"`; see the module doc. */
export const PERSONA_SUFFIX_KEY = "active-persona";

/**
 * The section heading, worded like the base prompt's own last section so the
 * model reads it as one more section rather than as an afterthought.
 */
const SECTION_HEADING = "## Active persona";

/** The events a persona can change on — see the module doc. */
const RERENDER_ON: ReadonlySet<SessionEvent["type"]> = new Set([
  "tool.completed",
  "state.updated",
  "session.configured",
]);

/** What one session's roster is wired to. @internal */
export interface SessionPersonas {
  /** Offer one session event; re-renders and pushes on the two that matter. */
  observe(event: SessionEvent): void;
  /**
   * The per-step knobs for the pipeline, or `undefined` when no persona
   * declares a `toolChoice` or a `temperature` — in which case a handoff
   * changes the prompt and the gate's answer, and nothing about the request.
   */
  readonly turnKnobs: PersonaTurnSource | undefined;
  /**
   * The active persona's `interruption` group in the pipeline's units, or
   * `undefined` when no persona declares one — so a roster that never mentions
   * barge-in leaves the transport's interruption reads constant.
   */
  readonly interruption: PersonaInterruptionSource | undefined;
}

const NO_PERSONAS: SessionPersonas = {
  observe: () => undefined,
  turnKnobs: undefined,
  interruption: undefined,
};

/**
 * Bind an agent's roster to one session.
 *
 * **No suffix is installed when the agent declares no roster**, so every
 * session shipping today sends the byte-identical prompt it sent before this
 * module existed — the property `dialogs.ts` keeps for the same seam.
 *
 * @internal
 */
export function openSessionPersonas(
  roster: Roster | undefined,
  sessionId: string,
  deps: {
    prompt: SessionSystemPrompt;
    /** The same slot view a tool call's `ctx.slots` is. */
    slots: SlotStore;
    /** This session's transport, resolved LATE — built after this is. */
    transport: () => Transport | undefined;
    logger: Logger;
  },
): SessionPersonas {
  // A roster whose entries all run off the line has nobody to put on it: no
  // section, no knobs — the prompt stays byte-identical, as with no roster.
  if (roster === undefined) return NO_PERSONAS;
  const entry = roster.speaking[0];
  if (entry === undefined) return NO_PERSONAS;
  // Re-bound as consts: the readers below are hoisted function declarations,
  // which TypeScript does not narrow through, and the two guards above are
  // what make these non-optional.
  const live: Roster = roster;
  const first: SpeakerDef = entry;
  const { prompt, transport, logger } = deps;
  const ctx: SlotHolder = { slots: deps.slots, sessionId };
  const varies = roster.speaking.some(
    (one) => one.toolChoice !== undefined || one.temperature !== undefined,
  );
  const interrupts = roster.speaking.some((one) => one.interruption !== undefined);

  /**
   * Who is speaking, with a stale slot contained.
   *
   * `position` throws when the slot names a persona the roster no longer has —
   * a session resumed across a redeploy that renamed one. That is the entry
   * persona's call to take, with the reason in the log, rather than a throw out
   * of prompt assembly on a live turn.
   */
  function speaking(): ReturnType<Roster["position"]> {
    try {
      return live.position(ctx);
    } catch (err: unknown) {
      logger.warn("Persona position unreadable; answering as the entry persona", {
        sessionId,
        error: errorMessage(err),
      });
      return { speaker: first };
    }
  }

  function render(): string {
    const at = speaking();
    const lines = [`${SECTION_HEADING}: ${at.speaker.name}`, at.speaker.systemPrompt];
    if (at.from !== undefined) {
      lines.push(
        at.note === undefined
          ? `The caller was handed to you by ${at.from}.`
          : `The caller was handed to you by ${at.from}, who noted: ${at.note}`,
      );
    }
    return lines.join("\n");
  }

  // THE install — a thunk that renders fresh, so the pipeline is correct with
  // no push at all. Keyed, and the key is chosen to sort ahead of the dialogs'.
  prompt.setSuffix(PERSONA_SUFFIX_KEY, render);

  /**
   * The position last pushed to the transport — see `observe`. Compared rather
   * than the rendered section: `render` reads exactly these fields, and a
   * speaker is one roster object for the session.
   */
  let pushed: ReturnType<Roster["position"]> | undefined;
  const samePosition = (at: ReturnType<Roster["position"]>): boolean =>
    at.speaker === pushed?.speaker && at.from === pushed.from && at.note === pushed.note;

  return {
    observe(event) {
      if (!RERENDER_ON.has(event.type)) return;
      // A transport that resolves the prompt per request (the pipeline) has
      // nothing to push: the suffix thunk above already answers fresh.
      const live = transport();
      if (!live?.capabilities.promptPush) return;
      const next = speaking();
      if (pushed === undefined) {
        // The first look primes rather than pushes: the transport's own open
        // already sent this section, and a resume hydrates the slot before the
        // first event lands (`session.configured`), so this is the true start.
        pushed = next;
        return;
      }
      if (samePosition(next)) return;
      pushed = next;
      live.refreshSystemPrompt?.();
    },
    turnKnobs: varies
      ? () => {
          const { speaker } = speaking();
          return omitUndefined({
            toolChoice: speaker.toolChoice,
            temperature: speaker.temperature,
          });
        }
      : undefined,
    interruption: interrupts ? () => interruptionKnobs(speaking().speaker.interruption) : undefined,
  };
}
