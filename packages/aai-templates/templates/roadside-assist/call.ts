import type { AnyDialog, DialogBargeIn, DialogTimeoutSpec } from "@alexkroman1/aai";
import { dialog } from "@alexkroman1/aai";

/**
 * Where a roadside call IS, as a dialog — and the one place in this template
 * where the conversation itself is the subject.
 *
 * `shared.ts` holds the vehicle, the policy and the truck. None of those is a
 * position: a caller can be covered and unlocated, or located and unverified,
 * and asking the data which of those is true is how a call ends up asking for
 * the policy number twice. What a position says is which of the four things
 * this desk does is in front of the agent right now.
 *
 * Five phases, and each one is here because a real roadside call needs
 * something from the SDK that a prompt cannot carry:
 *
 * | state | what it needs | what carries it |
 * | --- | --- | --- |
 * | `onCall.locating` | a caller who has gone quiet gets re-prompted, and a talkative one does not | `timeout` + a self transition on `@user-transcript.committed` |
 * | `onCall.quiet` | the re-prompt is a different instruction, not a louder one | `instruction` |
 * | `onCall.verifying` | do not invent a policy, and give up after two minutes | `temperature` + `timeout` |
 * | `onCall.disclosure` | the fee disclosure is delivered IN FULL | `bargeIn: "off"` |
 * | `onCall.dispatching` | do not promise a truck without sending one | `toolChoice` |
 * | `abandoned` | nothing acts on a call whose caller is gone | `final: true` |
 *
 * All six of those reach a session only because `agent({ dialogs })` lists this
 * dialog — see {@link DIALOGS}. An undeclared dialog still gates its tools and
 * still moves on `send`; what it does not get is a clock, a session event, or a
 * knob, because every one of those happens when no tool is running.
 */

// ─── The two deadlines ───────────────────────────────────────────────────────

/**
 * The silence ladder's first rung.
 *
 * The clock runs from the dialog's last MOVE, and `onCall.locating` declares a
 * self transition on `@user-transcript.committed` — so every committed turn is
 * a move, re-arms this window, and only real silence ever reaches it. That is
 * what makes the number a SILENCE budget rather than a call budget: a caller
 * who is talking us through what happened can take as long as they like.
 *
 * Twelve seconds is chosen against what restarts it. A COMMITTED turn is the
 * event, not a partial, so a caller in the middle of one long sentence can
 * reach this deadline while still speaking — which is exactly why `QUIET` leads
 * to a nudge rather than to anything irreversible.
 */
const SILENCE_LADDER: DialogTimeoutSpec = { afterMs: 12_000, send: "QUIET" };

/**
 * The verification deadline — and the shape the ladder above is NOT.
 *
 * `onCall.verifying` declares no transition on anything the caller says, so
 * nothing the caller says extends this window: it is wall clock from the moment
 * the phase began. That is the point. A caller who cannot find their card will
 * talk the whole two minutes, and a deadline they could extend by talking is a
 * deadline that never fires on the only call that needs it.
 *
 * What it fires is `UNVERIFIED`, which moves the call ON to the disclosure at
 * the non-member rate rather than ending it. A stranded caller still needs a
 * truck; what they have run out of is the discount.
 */
const VERIFICATION_DEADLINE: DialogTimeoutSpec = { afterMs: 120_000, send: "UNVERIFIED" };

// ─── The one knob that is a legal requirement ────────────────────────────────

/**
 * The agent finishes the disclosure, whatever the caller does over the top of
 * it.
 *
 * `"off"` is an unreachable word threshold rather than a deaf agent: the caller
 * is still transcribed, still opens the speaking edge, and is still answered as
 * soon as the disclosure ends. What it removes is the barge-in — the agent will
 * not stop mid-sentence — and this is the case where that is obviously right
 * rather than a preference. A fee disclosure that was cut off after nine words
 * was not read, and "the caller interrupted" is not a defence anyone has ever
 * won with.
 *
 * A named constant because the argument is the interesting part; inline it is
 * two characters that read like a whim.
 */
const UNINTERRUPTIBLE: DialogBargeIn = "off";

// ─── The call ────────────────────────────────────────────────────────────────

/**
 * `as const` is load-bearing: the event union is synthesized from the `on` keys,
 * so widening them to `string` gives every `send` below nothing to check
 * against.
 *
 * **The hang-up is declared ONCE, on the parent.** Being in a state is being in
 * all of them, so `@session.timed-out` on `onCall` reaches all five phases —
 * where the same line repeated five times is five chances for the sixth phase
 * to be added without it. The contrast with `@user-transcript.committed` is the
 * lesson: that one is declared on ONE state, because only the silence ladder
 * cares that the caller said something, and hoisting it would silently turn the
 * verification deadline into one a talkative caller can extend forever.
 */
const callSpec = {
  initial: "onCall",
  states: {
    onCall: {
      initial: "locating",
      on: { "@session.timed-out": "abandoned" },
      states: {
        locating: {
          instruction:
            "You do not know where this caller is or what they are driving. Get both, plus " +
            "what went wrong, and whether they are somewhere they can safely wait — then call " +
            "report_location. If they are in a live traffic lane or hurt, that comes first: " +
            "tell them to call emergency services and stay out of the roadway.",
          // A stranded caller correcting an address must be able to cut in on
          // the first word, so this phase is MORE interruptible than the
          // agent's own default. It costs the occasional false start on a
          // single-word STT partial, which on a phase made of short questions
          // is the cheaper of the two mistakes.
          bargeIn: { minWords: 1 },
          timeout: SILENCE_LADDER,
          on: {
            // A self transition, and the whole silence ladder rests on it: it
            // is a MOVE, so it re-arms the deadline above. Nothing else here
            // extends it.
            "@user-transcript.committed": "locating",
            QUIET: "quiet",
            LOCATED: "verifying",
          },
        },
        quiet: {
          instruction:
            "The caller has said nothing for a while. They may have put the phone down, be " +
            "standing outside the car, or be on a bad line. Say one short sentence — ask if " +
            "they are still there and whether they are safe — and then wait. Do not repeat " +
            "the whole question, and do not start over.",
          on: {
            // Hearing anything at all puts the call back on the ladder's first
            // rung, which re-arms the window from that moment.
            "@user-transcript.committed": "locating",
            LOCATED: "verifying",
          },
        },
        verifying: {
          instruction:
            "You know where they are and what is wrong. Now find out what they are covered " +
            "for: ask for the policy number on their card, or the phone number the plan is " +
            "under, and call lookup_coverage with it. Never tell a caller they are covered " +
            "because it sounds likely — the lookup is the only thing that knows.",
          // Reading a policy number back and matching it against what the
          // caller said is transcription, not composition. The low temperature
          // is aimed at the one failure this phase has: a model that smooths
          // `RS-8802` into `RS-8002` because it reads better.
          temperature: 0.2,
          timeout: VERIFICATION_DEADLINE,
          on: { VERIFIED: "disclosure", UNVERIFIED: "disclosure" },
        },
        disclosure: {
          instruction:
            "Before any truck moves, the caller has to hear the service-fee disclosure. Call " +
            "service_disclosure, read back exactly what it gives you — all of it, in those " +
            "words, without summarising — and then ask whether they want to go ahead. Call " +
            "acknowledge_disclosure with what they answered.",
          bargeIn: UNINTERRUPTIBLE,
          on: { DISCLOSED: "dispatching" },
        },
        dispatching: {
          instruction:
            "They have heard the fee and agreed to it. Send the truck with dispatch_truck, " +
            "then tell them the callsign, the ETA and the total. If they ask again later, " +
            "give them the same job and the same number.",
          // The failure this pin exists for is an agent that says "I'm getting
          // someone out to you" and calls nothing. Safe HERE and nowhere else
          // in this dialog: `dispatch_truck` needs nothing the caller has not
          // already said, and it answers with the job it already created rather
          // than rolling a second truck — so a pinned step that fires again on
          // a later turn costs one idempotent call and changes nothing. A pin
          // on `verifying`, where the tool needs a policy number the caller may
          // not have given yet, would force the model to invent one.
          toolChoice: { type: "tool", toolName: "dispatch_truck" },
        },
      },
    },
    abandoned: {
      final: true,
      instruction:
        "The caller is gone. Do nothing further on this call — no dispatch, no lookup, no " +
        "callback promise.",
    },
  },
} as const;

/**
 * The call's position, on its own slot key beside `roadsideSlot`.
 *
 * A final state delivers no events, so there is no way out of `abandoned` and
 * no `on` map pretending there is: a session that reaches it refuses every
 * gated tool for the rest of its life, which is the guarantee that a truck
 * cannot be dispatched to a caller who hung up two minutes ago. Starting over
 * is `roadsideCall.reset`, not an event.
 */
export const roadsideCall = dialog("call", callSpec);

/**
 * What `agent({ dialogs })` is handed.
 *
 * Typed as `readonly AnyDialog[]` rather than left to inference, because that
 * erasure is the reason the field can hold more than one dialog at all: two
 * dialogs have different event unions by construction, so the only type an
 * array of them has is the one with `E` erased. Writing it here is also where a
 * second dialog would be added, which is a better place to find out than the
 * `agent()` call.
 */
export const DIALOGS: readonly AnyDialog[] = [roadsideCall];

/**
 * Both rungs of the silence ladder, for the one tool that ends it.
 *
 * `report_location` is legal in `onCall.locating` and in `onCall.quiet`: a
 * caller who finally speaks after the nudge is giving us the address, and a
 * gate that refused them there would be refusing the call's whole purpose one
 * beat after asking for it.
 */
export const LOCATING = ["onCall.locating", "onCall.quiet"] as const;

/**
 * Every state a caller is still on the line in — i.e. everything but the final
 * one.
 *
 * `"onCall"` matches all five of its children, which is what makes a read legal
 * throughout the call and refused the moment it ends. The same shape as
 * `retail`'s `BEFORE_TRANSFER`, and the same reason: "needs no phase in
 * particular" and "is still legal after the caller is gone" were never the same
 * claim.
 */
export const ON_THE_LINE = "onCall";
