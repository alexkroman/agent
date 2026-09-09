import { toolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { digitsOf, normalizeCode, speakCode, spokenDate } from "../records.ts";
import { hotelSlot } from "../session.ts";
import { note } from "../shared.ts";

/** Failed lookups before a human takes over — their `_attempts >= 3`. */
export const MAX_VERIFY_ATTEMPTS = 3;

/**
 * Verify the caller against a booking — their `VerifyBookingTask`, whose two
 * tools were `lookup_by_code` and `lookup_by_card` and whose instructions named
 * the ONLY two paths: last name plus code, or last name plus the card's last
 * four. Email is not a verification field and is not accepted here.
 *
 * Success fills `verifiedCode`, which every booking tool reads through
 * `requireVerified` — so the desk verifies once per call, and a tool that
 * needs a verified booking refuses with the sentence naming this one. Their
 * three-strike rule is the counter: past it the result says to stop trying and
 * record a `verification_help` followup for a manager.
 */
export default hotelSlot.updateTool({
  description:
    "Verify the caller against their room booking: last name plus confirmation code (HTL-XXXX), " +
    "or last name plus the last four digits of the card on file. Call it BEFORE any lookup, " +
    "change, dispute or cancellation - never vet these details in conversation first, and never " +
    "ask for an email to verify. Cancelled bookings verify only through reinstate_booking.",
  inputSchema: z.object({
    lastName: z.string().min(1),
    confirmationCode: z
      .string()
      .optional()
      .describe("As the caller read it, e.g. 'H T L dash A B 1 2'"),
    cardLast4: z.string().optional().describe("The last four digits of the card on file"),
  }),
  execute({ lastName, confirmationCode, cardLast4 }, hotel) {
    const wantedName = lastName.trim().toLowerCase();
    const code = confirmationCode === undefined ? null : normalizeCode(confirmationCode);
    const digits = cardLast4 === undefined ? null : digitsOf(cardLast4);
    if (code === null && digits === null) {
      return toolFailure(
        "verification needs the last name PLUS a confirmation code or the card's last four digits",
      );
    }
    if (digits !== null && digits.length !== 4) {
      return toolFailure(
        "the last 4 digits should be exactly 4 digits - ask the caller to repeat them",
      );
    }
    const match = hotel.bookings.find(
      (b) =>
        b.status === "confirmed" &&
        b.lastName.toLowerCase() === wantedName &&
        (code === null || normalizeCode(b.code) === code) &&
        (digits === null || b.cardLast4 === digits),
    );
    if (match === undefined) {
      hotel.verifyAttempts += 1;
      const cancelled = hotel.bookings.some(
        (b) =>
          b.status === "cancelled" &&
          b.lastName.toLowerCase() === wantedName &&
          (code === null || normalizeCode(b.code) === code),
      );
      if (hotel.verifyAttempts >= MAX_VERIFY_ATTEMPTS) {
        return toolFailure(
          `verification failed ${hotel.verifyAttempts} times - don't keep trying. Apologize, then call ` +
            'record_followup with kind "verification_help" so a manager can follow up.',
        );
      }
      if (cancelled) {
        return toolFailure(
          "that booking was already cancelled. Ask if the caller meant a different reservation - or, " +
            "if they want it back, reinstate_booking is the tool that verifies against a cancelled one.",
        );
      }
      return toolFailure(
        `No confirmed booking found via ${code === null ? "card" : "code"} for that last name. Politely ask the ` +
          `caller to repeat, or offer the other path (${code === null ? "the confirmation code" : "the card's last four"}). ` +
          `Attempt ${hotel.verifyAttempts} of ${MAX_VERIFY_ATTEMPTS}.`,
      );
    }
    hotel.verifiedCode = match.code;
    hotel.verifyAttempts = 0;
    note(hotel, `Verified ${match.code} (${match.lastName})`);
    return {
      verified: true,
      code: match.code,
      spokenCode: speakCode(match.code),
      guest: `${match.firstName} ${match.lastName}`,
      checkIn: spokenDate(match.checkIn),
      checkOut: spokenDate(match.checkOut),
      next: "The caller is verified for this call. Continue with what they asked for - the booking tools no longer need to verify.",
    };
  },
});
