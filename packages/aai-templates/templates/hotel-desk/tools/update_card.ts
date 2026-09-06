import { toolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { validateCard } from "../card.ts";
import { hotelSlot, note, requireVerified } from "../shared.ts";

/**
 * Replace the card on file — their `start_card_update`, which verified and then
 * ran a `GetCardTask`. The same `validateCard` as `record_card`, so a misheard
 * digit bounces with the field to re-ask, and only the last four is stored.
 */
export default hotelSlot.updateTool({
  description:
    "Replace the card on file for the verified caller's booking - the path when a card isn't going " +
    "through or they want a different card charged. Take the whole card (number, expiry, security " +
    'code, name) then call this. Keep it discreet: "isn\'t going through at the moment", never ' +
    '"declined". Verify first.',
  inputSchema: z.object({
    cardNumber: z.string(),
    expiryMonth: z.number().int(),
    expiryYear: z.number().int(),
    securityCode: z.string(),
    cardholderName: z.string(),
  }),
  execute(args, hotel) {
    const booking = requireVerified(hotel);
    if ("error" in booking) return toolFailure(booking.error);
    if (booking.status !== "confirmed") {
      return toolFailure(
        `booking ${booking.code} is ${booking.status} - there's no active booking to update`,
      );
    }
    const card = validateCard(args);
    if ("error" in card) return toolFailure(card.error);
    booking.cardLast4 = card.last4;
    note(hotel, `Card on ${booking.code} replaced: ending ${card.last4}`);
    return {
      updated: true,
      cardLast4: card.last4,
      issuer: card.issuer,
      message:
        `Card on file updated to the one ending ${card.last4}. Confirm to the caller that the new card ` +
        "is on the booking and everything is set for their stay; no further tool call is needed.",
    };
  },
});
