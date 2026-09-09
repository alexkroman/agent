import { toolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { bookingStatus, nextStep } from "../booking.ts";
import { AFTER_EXTRAS, deskFlow } from "../desk.ts";
import { digitsOf } from "../records.ts";
import { hotelSlot } from "../session.ts";

/**
 * Record the guest's name, email and phone — their three `beta.workflows`
 * tasks (`GetNameTask`, `GetEmailTask`, `GetPhoneNumberTask`) as one tool that
 * takes any subset, so a detail is stored the moment it is given and a later
 * hiccup never re-asks it.
 *
 * The read-back-and-confirm those tasks did lives in the state's instruction:
 * a spelled value is the value, letter by letter.
 */
export default deskFlow.tool({
  description:
    "Record the guest's name, email and/or phone for the booking - any subset, the moment each is " +
    "given. A spelled name or email is recorded as spelled. Call again to correct a detail.",
  when: AFTER_EXTRAS,
  inputSchema: z.object({
    firstName: z.string().min(1).optional(),
    lastName: z.string().min(1).optional(),
    email: z.string().optional(),
    phone: z.string().optional(),
  }),
  execute: (args, ctx) =>
    hotelSlot.update(ctx, (hotel) => {
      const d = hotel.draft;
      if (d === null)
        return toolFailure("No booking flow is open - call start_room_booking first.");
      if (
        args.firstName === undefined &&
        args.lastName === undefined &&
        args.email === undefined &&
        args.phone === undefined
      ) {
        return toolFailure(
          "nothing to record - pass at least one of firstName, lastName, email, phone",
        );
      }
      if (args.email !== undefined) {
        const email = args.email.trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          return toolFailure(
            `"${args.email}" doesn't read as an email address - ask the caller to spell it`,
          );
        }
        d.email = email;
      }
      if (args.phone !== undefined) {
        const digits = digitsOf(args.phone);
        if (digits.length < 7)
          return toolFailure("that phone number is too short - ask the caller to repeat it");
        d.phone = digits;
      }
      if (args.firstName !== undefined) d.firstName = args.firstName.trim();
      if (args.lastName !== undefined) d.lastName = args.lastName.trim();
      return {
        recorded: {
          name: d.firstName && d.lastName ? `${d.firstName} ${d.lastName}` : null,
          email: d.email,
          phone: d.phone,
        },
        status: bookingStatus(d),
        next: nextStep(d),
      };
    }),
  sendFrom: (result) => ({ type: result.next }),
});
