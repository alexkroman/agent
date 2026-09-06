import { toolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { openDinnerSlots, reserveTable } from "../hotel.ts";
import { DINNER_SLOTS, isIsoDate, speakCode, spokenDate, spokenTime, TODAY } from "../records.ts";
import { hotelSlot } from "../shared.ts";

/**
 * Book a table — their `BookRestaurantTask`, collapsed to one call.
 *
 * That task existed for one coupling (open slots depend on the date and the
 * party) and otherwise collected independent values one dialog at a time. The
 * coupling survives as the refusal: a slot that is not open comes back with the
 * slots that are, so the model offers those and calls again. Their
 * `MAX_PARTY_SIZE` bail-out survives too — a bigger party is private dining the
 * restaurant arranges directly, never a table quietly shrunk to fit.
 */
export default hotelSlot.updateTool({
  description:
    "Book a restaurant table once you have the date, time, party size, and the caller's name and " +
    "phone, read back and agreed. A time that is not open comes back with the open ones. Parties " +
    "over six are private dining - transfer_call to the restaurant instead.",
  inputSchema: z.object({
    date: z.string().describe("YYYY-MM-DD"),
    time: z.string().describe("24-hour HH:MM, e.g. 19:30"),
    partySize: z.number().int().min(1),
    firstName: z.string().min(1),
    lastName: z.string().min(1),
    phone: z.string().min(1),
    notes: z.string().max(200).optional().describe("Allergy, anniversary, seating wish"),
  }),
  execute(args, hotel) {
    if (!isIsoDate(args.date)) return toolFailure("the date must be YYYY-MM-DD");
    if (args.date < TODAY) return toolFailure("the date can't be in the past");
    if (args.partySize > 6) {
      return toolFailure(
        `${args.partySize} guests is beyond a normal table - we seat up to 6. Don't book it here and don't ` +
          "reduce the number to fit: this is a large-party / private-dining request the restaurant handles " +
          "directly. Tell the caller you'll put them on hold to connect them and, once they agree, " +
          'transfer_call(destination "restaurant") with a one-line summary.',
      );
    }
    if (!(DINNER_SLOTS as readonly string[]).includes(args.time)) {
      return toolFailure(
        `the restaurant seats at ${DINNER_SLOTS.map(spokenTime).join(", ")} - pick one of those`,
      );
    }
    const reservation = reserveTable(hotel, {
      firstName: args.firstName,
      lastName: args.lastName,
      phone: args.phone,
      partySize: args.partySize,
      date: args.date,
      time: args.time,
      notes: args.notes ?? null,
    });
    if ("error" in reservation) {
      const open = openDinnerSlots(hotel, args.date, args.partySize);
      if (open.length === 0)
        return toolFailure(
          `fully booked on ${spokenDate(args.date)} for ${args.partySize} - ask for another date`,
        );
      return toolFailure(
        `${spokenTime(args.time)} isn't open for that party; offer one of: ${open.map(spokenTime).join(", ")}`,
      );
    }
    return {
      reserved: true,
      code: reservation.code,
      spokenCode: speakCode(reservation.code),
      date: spokenDate(reservation.date),
      time: spokenTime(reservation.time),
      partySize: reservation.partySize,
      message:
        `You're set for ${spokenTime(reservation.time)} on ${spokenDate(reservation.date)} for ${reservation.partySize} ` +
        `guest${reservation.partySize === 1 ? "" : "s"}. Confirmation code ${speakCode(reservation.code)}. Relay this; ` +
        "no further tool call is needed.",
    };
  },
});
