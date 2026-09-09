import { agent } from "@alexkroman1/aai";
import { DIALOGS } from "./desk.ts";
import { DESK_EVENTS } from "./events.ts";
import { PRICING, spokenDate, TODAY, usd } from "./records.ts";
import { deskProjection } from "./session.ts";
import systemPrompt from "./system-prompt.md?raw";

/**
 * A boutique hotel's front desk, on the phone — LiveKit Agents'
 * `hotel_receptionist` example as a voice agent. `shared.ts` carries the
 * attribution and the their-name → our-name table; `session.ts` holds the slot
 * and the seeded factory, kept out of the browser's reach; `desk.ts` is the
 * booking flow and the reason this template needs `dialogs`.
 *
 * Forty-one tools, and the interesting property is how few of them the model
 * can call WRONG: every booking tool refuses until `verify_booking` has filled
 * the slot, every step of a room booking refuses outside its state, and
 * `confirm_booking` is reachable only through a read-back the caller has
 * answered. Their `HotelReceptionistAgent` got the same guarantees from
 * `AgentTask`s with narrowed tool sets; here they are gates.
 */
export default agent({
  name: "The Harborlight Hotel",
  description:
    "Takes a hotel front desk's calls: room bookings, restaurant tables, folios and concierge requests",
  // The receptionist's own screen: who is verified, what is being booked, and
  // the ledger of everything this call wrote — their SQLite changeset stream.
  syncState: deskProjection,
  /**
   * Wires `@user-transcript.committed` and `@session.timed-out` to the desk
   * dialog. Without it `offering` and `readBack` — the two states that exist to
   * make the model SPEAK before the next tool is legal — could never be left,
   * and a caller who hung up mid-booking would leave the flow open.
   */
  dialogs: DIALOGS,
  /**
   * The other half of the hang-up, and the pairing is the point: the dialog
   * above MOVES to `hungUp` so nothing more is said, and this WRITES the
   * `abandoned_booking` followup a dropped booking leaves behind. A transition
   * stores nothing and a handler cannot speak, so a call that ends badly needs
   * both. See `events.ts`.
   */
  events: DESK_EVENTS,
  // The prose is the document; the numbers are the price list, rendered from
  // `PRICING` so the receptionist can never quote a fee the tools don't charge.
  systemPrompt: `${systemPrompt}\n${quickFacts()}`,
  greeting: "The Harborlight Hotel, front desk. What can I do for you?",
});

/** Their `# Quick facts` section: hot-path facts inline, everything else in `lookup_policy`. */
export function quickFacts(): string {
  return [
    "# Quick facts (answer directly - no tool call needed)",
    `- Today is ${spokenDate(TODAY)}, ${TODAY.slice(0, 4)}.`,
    `- Check-in 3 PM, check-out 11 AM. Late checkout until 2 PM is ${usd(PRICING.lateCheckout)}, subject to availability.`,
    "- Late arrival is fine; the room is held all night on a confirmed booking. Photo ID at check-in.",
    `- Pets: pet-friendly rooms only, ${usd(PRICING.petFee)} per stay. Service animals always welcome at no charge.`,
    `- Smoking: smoking-permitted rooms on request; ${usd(PRICING.smokingCleaningFee)} cleaning fee for smoking in a non-smoking room.`,
    `- Self-parking free; valet ${usd(PRICING.valetPerNight)} per night.`,
    "- Wi-Fi free. Pool, gym, sauna 6 AM to 10 PM, free for guests.",
    `- Cancellation: free up to ${PRICING.cancellationWindowHours} hours before check-in; inside that window, one night is forfeited. Tax is ${PRICING.taxRatePct}% on room and extras. The full stay is charged at booking - there is no separate deposit.`,
    `- Breakfast buffet 6:30 to 10:30 AM, ${usd(PRICING.breakfastPerNight)} a night as a room extra.`,
    "- Restaurant: on-site, dinner only, 5:30 to 9 PM last seating. Room service 5:30 to 9:30 PM.",
    "- Luggage hold at the front desk before check-in and after check-out, no charge.",
  ].join("\n");
}
