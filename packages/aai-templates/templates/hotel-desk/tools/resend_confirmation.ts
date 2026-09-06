import { toolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { addTicket, hotelSlot, requireVerified } from "../shared.ts";

/**
 * Re-send a document to the email ON FILE — their `resend_confirmation` over
 * the stub `send_email`. It only ever goes to the recorded address: a caller
 * reading out a different one has to change the contact email first
 * (`record_followup`, kind `identity_change`), which is what stops a folio
 * being mailed to whoever knows a guest's last name and code.
 */
export default hotelSlot.updateTool({
  description:
    "Re-send the booking confirmation or the itemized folio to the email already on file for the " +
    "verified booking. It cannot go to a different address the caller reads out. Only say it's " +
    "sent after this returns.",
  inputSchema: z.object({ kind: z.enum(["booking_confirmation", "folio"]) }),
  execute({ kind }, hotel) {
    const booking = requireVerified(hotel);
    if ("error" in booking) return toolFailure(booking.error);
    const ticket = addTicket(
      hotel,
      "email",
      "EML",
      `${kind.replaceAll("_", " ")} re-sent to ${booking.email}`,
      {
        bookingCode: booking.code,
        recipient: booking.email,
        kind,
      },
    );
    return {
      sent: true,
      to: booking.email,
      reference: ticket.code,
      message: `Sent to the address on file, ${booking.email}.`,
    };
  },
});
