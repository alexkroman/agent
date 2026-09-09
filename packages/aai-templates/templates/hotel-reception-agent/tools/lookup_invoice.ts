import { isToolFailure, toolFailure } from "@alexkroman1/aai";
import { invoiceFor } from "../hotel.ts";
import { speakUsd } from "../records.ts";
import { hotelSlot } from "../session.ts";
import { requireVerified } from "../shared.ts";

/** Their `lookup_invoice`: the verified booking's line items, read back. */
export default hotelSlot.tool({
  description:
    "Fetch the verified caller's invoice and its line items - the step BEFORE any charge dispute, " +
    "so the dispute names a line exactly as it appears. Verify first.",
  execute(_args, hotel) {
    const booking = requireVerified(hotel);
    if (isToolFailure(booking)) return booking;
    const invoice = invoiceFor(hotel, booking.code);
    if (invoice === undefined) return toolFailure(`no invoice on file for ${booking.code}`);
    return {
      bookingCode: booking.code,
      total: speakUsd(invoice.total),
      paid: invoice.paid,
      lineItems: invoice.lineItems.map((li) => ({ label: li.label, amount: speakUsd(li.amount) })),
      next:
        "Surface only what the caller asked about. You can email an itemized copy to the address on " +
        `file, ${booking.email}, with resend_confirmation (kind folio) if they want one.`,
    };
  },
});
