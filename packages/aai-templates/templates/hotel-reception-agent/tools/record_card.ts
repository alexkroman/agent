import { isToolFailure, toolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { bookingStatus, nextStep } from "../booking.ts";
import { validateCard } from "../card.ts";
import { AFTER_DETAILS, deskFlow } from "../desk.ts";
import { hotelSlot } from "../shared.ts";

/**
 * Take the card for a new booking — their `GetCardTask`, whose four recording
 * tools each validated one field (Luhn, expiry, code length) so a bad value
 * bounced straight back with instructions to re-ask just that field. One call
 * here, and the refusal still names ONE field.
 *
 * **Only the last four digits ever reach the slot.** The number is checked and
 * discarded in the same expression, which is the property a voice agent taking
 * cards has to be able to show.
 */
export default deskFlow.tool({
  description:
    "Record the card for the booking once the caller has given the whole card: number, expiry, " +
    "security code and the name on it. Never read the full number or the code back. A rejected " +
    "value names the one field to re-ask.",
  when: AFTER_DETAILS,
  inputSchema: z.object({
    cardNumber: z.string().describe("All the digits, spaces or dashes allowed"),
    expiryMonth: z.number().int().describe("1-12"),
    expiryYear: z.number().int().describe("Two or four digits"),
    securityCode: z.string().describe("3 or 4 digits, leading zeros included"),
    cardholderName: z.string().describe("The name on the card, exactly as given"),
  }),
  execute: (args, ctx) =>
    hotelSlot.update(ctx, (hotel) => {
      const d = hotel.draft;
      if (d === null)
        return toolFailure("No booking flow is open - call start_room_booking first.");
      const card = validateCard(args);
      if (isToolFailure(card)) return card;
      d.cardLast4 = card.last4;
      return {
        recorded: `card ending ${card.last4}, ${card.issuer}`,
        status: bookingStatus(d),
        next: nextStep(d),
      };
    }),
  sendFrom: (result) => ({ type: result.next }),
});
