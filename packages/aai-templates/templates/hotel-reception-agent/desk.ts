/**
 * Where the CALL is, as a dialog — the receptionist's desk, and the booking flow
 * it hands off to and gets back from.
 *
 * Their architecture is one `HotelReceptionistAgent` whose booking tools each
 * `await` an `AgentTask` — a sub-agent with its own instructions and its own,
 * narrower tool set, that completes with a value. A voice session has one model
 * and one tool list for its whole life, so the sub-agent's two properties come
 * back as two properties of a dialog: its INSTRUCTIONS are the state's
 * `instruction`, in front of the model on every turn while the flow is open, and
 * its NARROWER TOOL SET is the `when` on each booking tool — `confirm_booking`
 * refuses from anywhere but `booking.agreeing`, exactly as their `_closed()`
 * refused a tool called outside its step.
 *
 * | BookRoomTask | here |
 * | --- | --- |
 * | `_Step` enum, `_ALLOWED[step]`, `_closed(tool)` | the `booking` children, each tool's `when`, and the SDK's refusal |
 * | `_step()` derived from the draft | `nextStep` (`booking.ts`), sent by every recording tool |
 * | `_must_offer` (armed when a re-dated pick dies) | `offering`, left on `@user-transcript.committed` |
 * | `_must_read_back` (armed on every change) | `readBack`, left on `@user-transcript.committed` |
 * | `complete(booking)` / `give_up` | `BOOKED` / `ABANDONED`, both back to `desk` |
 *
 * **The two `_Owed` states are the reason this needs `agent({ dialogs })`.** An
 * obligation to SPEAK is discharged by the caller's next turn, which no tool
 * call can observe; a session event can. `offering` and `readBack` each declare
 * one transition, on `@user-transcript.committed`, and the state it leads to is
 * where the gated tool becomes legal. That is their `_Owed.pending(turns)` with
 * the counter deleted — and it holds for a caller who types as for one who
 * speaks, which their comment records as the reason the counter read the
 * history rather than a VAD hook.
 *
 * **`booking`'s `on` map is the step ladder, declared ONCE on the parent.** A
 * recording tool may land the flow on any step (a corrected date invalidates the
 * room, a different room reprices the extras), so every step event is legal
 * from every child. XState's `.child` targets are what make one map serve all
 * eight children without re-entering the parent.
 */

import type { AnyDialog, ToolChoice } from "@alexkroman1/aai";
import { dialog } from "@alexkroman1/aai";

/**
 * The two owed-SPEECH states forbid a tool call outright.
 *
 * `offering` and `readBack` exist because something has to be SAID before the
 * next tool is legal — the options offered, the booking read back — and each
 * one's `when` gate already refuses the tool that would jump the queue. What
 * the gate cannot do is stop the model reaching for a DIFFERENT tool instead of
 * speaking: `lookup_policy` on a cancellation question, a second
 * `record_guest_details` "to be sure". Either way the turn ends with a tool
 * result rather than a sentence, the caller has nothing to answer, and the
 * transition out of the state — `@user-transcript.committed` — never fires.
 *
 * `toolChoice: "none"` is the rule stated instead of asked for: for that turn
 * the model has no tools at all, so the only thing it can produce is the
 * sentence the state's `instruction` describes. Named once because both states
 * carry the same rule for the same reason; typed {@link ToolChoice} because a
 * standalone `"none"` would widen to `string` and stop being checked against
 * the four the field admits.
 */
const SPEAK_ONLY: ToolChoice = "none";

const deskSpec = {
  initial: "desk",
  states: {
    desk: {
      instruction:
        "You are the lead receptionist holding the whole call. Route each request to its tool; " +
        "verification is something the booking tools do, not you. To book a room call " +
        "start_room_booking the moment the caller wants one - do not collect name, email, phone " +
        "or card before it is running. To change an existing booking, start_booking_modification.",
      on: {
        BOOKING_STARTED: "booking",
        MODIFY_STARTED: "booking.editing",
        "@session.timed-out": "hungUp",
      },
    },
    booking: {
      initial: "stay",
      on: {
        NEED_STAY: ".stay",
        OFFER: ".offering",
        NEED_ROOM: ".room",
        NEED_EXTRAS: ".extras",
        NEED_DETAILS: ".details",
        NEED_CARD: ".card",
        READ_BACK: ".readBack",
        BOOKED: "desk",
        ABANDONED: "desk",
        "@session.timed-out": "hungUp",
      },
      states: {
        stay: {
          instruction:
            "A room booking is open. Scan the conversation: if dates and party size were already " +
            "said, call set_stay with them now; otherwise ask for check-in, check-out and how " +
            "many guests - one question per turn - then call set_stay. Its result lists the room " +
            "options; OFFER them, never pick one.",
        },
        offering: {
          toolChoice: SPEAK_ONLY,
          instruction:
            "The dates changed and the room the caller had picked is no longer available for them. " +
            "Tell them, offer the room types set_stay just returned, and ask which they want. " +
            "choose_room stays closed until they have answered.",
          on: { "@user-transcript.committed": "room" },
        },
        room: {
          instruction:
            "The stay is recorded. Ask which room type (and view, if they care), then call " +
            "choose_room with exactly what they chose. If they ask about extras or prices, the " +
            "set_stay result is your reference - do not quote a total yet.",
        },
        extras: {
          instruction:
            "The room is recorded and there is no total yet. Offer the extras choose_room " +
            "listed - breakfast, valet, late checkout, pets - and call set_extras with an " +
            "explicit answer for each. The total only exists once this is answered.",
        },
        details: {
          instruction:
            "Room and extras are recorded. Collect the guest's name, email and phone, one at a " +
            "time, reading spelled values back letter by letter, and call record_guest_details " +
            "with what you have - it accepts any subset, so record each detail the moment it is " +
            "given.",
        },
        card: {
          instruction:
            "Everything but the card is recorded. Take the card: number, expiry, security code " +
            "and the name on it, then call record_card. Never read the full number or the code " +
            "back - refer to the card by its last four only. If a value is rejected, ask for " +
            "just that detail again.",
        },
        readBack: {
          // Reading dates, a total and a card's last four back is transcription,
          // and the failure it has is a model smoothing one number into another.
          temperature: 0.2,
          toolChoice: SPEAK_ONLY,
          instruction:
            "Every detail is captured. Read the booking back in ONE sentence - dates, guests, " +
            "room and extras, the total the tool quoted, the card's last four - and ask if that " +
            "is right. Then WAIT. confirm_booking is closed until the caller has answered.",
          on: { "@user-transcript.committed": "agreeing" },
        },
        agreeing: {
          temperature: 0.2,
          instruction:
            "The caller has heard the read-back. If they agreed, call confirm_booking now - the " +
            "call IS your reply. If they corrected a detail, call the matching recording tool; " +
            "the flow returns to the read-back. If they no longer want the room, abandon_booking.",
        },
        editing: {
          instruction:
            "You are modifying an existing booking, loaded and verified. Read it back briefly " +
            "in one sentence - guest, dates, room type, extras - and ask what to change. Apply " +
            "ONLY the changes the caller asks for with set_stay, choose_room and set_extras. " +
            "Name, email, phone and card cannot change here (record_followup for identity, " +
            "update_card for a card). To cancel instead, abandon_booking then cancel_room_booking.",
        },
      },
    },
    hungUp: {
      final: true,
      instruction:
        "The caller is gone. Do nothing further on this call - no booking, no lookup, no " +
        "callback promise.",
    },
  },
} as const;

/**
 * The call's position, on its own slot key beside `hotelSlot`.
 *
 * `hungUp` is `final`: a booking abandoned mid-flow by a hang-up must not be
 * confirmed by a model that keeps talking to a dead line. Their
 * `abandoned_booking` followup is the human half of the same case, and it is
 * written by `events.ts` on the SAME event — a transition decides what may
 * still be done, a handler records what happened, and neither does the other's
 * job.
 */
export const deskFlow = dialog("desk", deskSpec);

/**
 * What `agent({ dialogs })` is handed — the line that wires
 * `@user-transcript.committed` and `@session.timed-out` to the dialog. Without
 * it the two owed states could never be left.
 */
export const DIALOGS: readonly AnyDialog[] = [deskFlow];

/** Every state a recording tool may run in: the whole booking flow. */
export const IN_BOOKING = "booking";

/**
 * The booking steps in the order they are reached. Every gate below is a
 * SUFFIX of this, so each is sliced from it rather than typed out: adding a
 * step to the ladder used to mean editing up to four hand-kept lists, and a
 * miss was silent — the tool simply refused at the new step.
 */
const LADDER = ["room", "extras", "details", "card", "readBack", "agreeing"] as const;

/** The ladder from `step` onward, as dialog positions. */
function from<S extends (typeof LADDER)[number]>(step: S) {
  return LADDER.slice(LADDER.indexOf(step)).map((s) => `booking.${s}` as const);
}

/**
 * Where `choose_room` may run: any step past the stay, and NOT `offering` —
 * the options have to be spoken before a room can be picked, and the caller's
 * next turn is what opens the step.
 *
 * `editing` is reachable from here and from {@link AFTER_ROOM} but NOT from the
 * two below: the guest's name and card cannot be changed from that state, so
 * the asymmetry is a decision rather than an omission.
 */
export const AFTER_STAY = [...from("room"), "booking.editing"] as const;

/** Where `set_extras` may run: once a room is on the draft. */
export const AFTER_ROOM = [...from("extras"), "booking.editing"] as const;

/** Where the guest's details may be recorded or corrected. */
export const AFTER_EXTRAS = from("details");

/** Where the card may be taken or corrected. */
export const AFTER_DETAILS = from("card");
