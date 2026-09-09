import type { AgentGuardrail } from "@alexkroman1/aai";
import { callInHand, dispatchSlot } from "./shared.ts";

/**
 * The one rule on this desk that the tool gates cannot hold: **never say help
 * is coming before a unit has been assigned.**
 *
 * Everything else here is enforced structurally. Six mutating tools refuse
 * until something has been logged, every one of them is addressed by incident
 * id, and `callFlow`'s `dispatching` state says "never leave a critical
 * incident without at least one" on every turn. None of that reaches the
 * SPEECH: a model that has been told to dispatch and has not can still tell the
 * room that Medic-1 is rolling, and the gates have nothing to say about it,
 * because no tool ran. That is the hole `outputGuardrails` closes — it is the
 * only declaration on an agent that can stop a turn, and `agent({ events })`
 * deliberately cannot (a handler's return value is ignored).
 *
 * **It is pipeline-mode only, and refused at config time in the other two.**
 * S2S synthesizes provider-side, so the words reach this runtime after the
 * caller has heard them; text mode hands its caller the model stream directly
 * and owns no point at which to hold a reply. `agent-guardrails.ts` argues
 * both.
 *
 * ## What it costs, and why this desk can pay it
 *
 * A reply that has to be judged whole cannot be spoken as it arrives, so
 * declaring one trades time-to-first-word for the check — the whole reply is
 * held until the model finishes. That is a real regression on a live call and
 * it is not free here either. What makes it bearable is the shape of this
 * agent's speech: `system-prompt.md` asks for radio traffic ("Medic-1, respond
 * priority one to 400 Oak Street"), so a reply is one or two short lines rather
 * than a paragraph, and the dead-air cover is exempt from the hold and fills
 * the gap exactly as it does during a tool chain.
 *
 * A desk that spoke at length would be the wrong place for this. The test is
 * whether the sentence being checked is worth waiting for the whole of, and on
 * a dispatch floor it is.
 */
export const DISPATCH_GUARDRAILS: readonly AgentGuardrail[] = [
  (text, ctx) => {
    // The STATE half, and it is what keeps this from being a keyword filter: an
    // `AgentSessionContext` carries `slots`, so the check can ask the board
    // whether the claim is true rather than whether the sentence looks bad.
    // `callInHand` is the same reading of "which incident" that `events.ts`
    // uses for a dropped call — the most recently touched open one.
    const incident = callInHand(dispatchSlot.get(ctx));
    if (incident !== undefined && incident.assignedResources.length > 0) return true;
    if (!claimsUnitsMoving(text)) return true;
    return (
      "Correction — nothing is rolling on that call yet. Assign a unit with " +
      "resources_dispatch, then say so."
    );
  },
];

/** One sentence at a time, so a hedge in one clause does not excuse the next. */
const SENTENCES = /[^.!?]+[.!?]?/g;

/** The desk asserting that something is already moving. */
const MOVING = /\b(?:on (?:the|their) way|en ?route|rolling|responding|inbound|underway)\b/i;

/**
 * Words that make the same sentence a denial, a condition or a plan rather than
 * a claim — "no units are en route yet", "once Medic-1 is rolling", "I'll get
 * someone responding".
 */
const NOT_A_CLAIM =
  /\b(?:no|not|n't|none|nothing|never|nobody|yet|once|when|if|until|before|after|will|'ll|going to|need|should|about to)\b/i;

/**
 * Does this reply tell the room that units are already moving?
 *
 * A keyword heuristic, and the bias is deliberate: `NOT_A_CLAIM` is broad, so
 * the check MISSES a claim far more often than it blocks an innocent sentence.
 * That is the right way round for a guardrail whose verdict is spoken over the
 * top of a dispatcher — a missed claim leaves the desk where it was, and a
 * false block interrupts a shift with a correction that is not true.
 *
 * The state gate above is what makes the false-positive rate tolerable at all:
 * this function is only ever consulted on an incident with nothing assigned to
 * it, which on a working shift is a minority of turns.
 *
 * Exported because it is the half worth testing directly — the guardrail around
 * it is two branches over the board.
 */
export function claimsUnitsMoving(text: string): boolean {
  return (text.match(SENTENCES) ?? []).some(
    (sentence) => MOVING.test(sentence) && !NOT_A_CLAIM.test(sentence),
  );
}
