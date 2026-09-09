import { toolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { bookingStatus, nextStep, requote } from "../booking.ts";
import { AFTER_ROOM, deskFlow } from "../desk.ts";
import { type RoomExtra, speakUsd } from "../records.ts";
import { hotelSlot } from "../session.ts";

/**
 * Record the caller's answer on each extra — their `set_extras`.
 *
 * One boolean per extra rather than a list, for their reason: the model has to
 * answer for every one, so an extra it never raised with the caller cannot be
 * quietly left out the way an omitted list member is. This is where the total
 * is computed, because every extra moves it.
 */
export default deskFlow.tool({
  description:
    "Record the caller's answer on each extra, after you have offered them. Every extra takes an " +
    "explicit true or false - all four false is a real answer. The stay's total is computed here.",
  when: AFTER_ROOM,
  inputSchema: z.object({
    breakfast: z.boolean(),
    valet: z.boolean(),
    lateCheckout: z.boolean(),
    pets: z.boolean(),
  }),
  execute: (args, ctx) =>
    hotelSlot.update(ctx, (hotel) => {
      const d = hotel.draft;
      if (d === null)
        return toolFailure("No booking flow is open - call start_room_booking first.");
      if (d.roomType === null) return toolFailure("no room recorded yet - call choose_room first");
      const answers: [RoomExtra, boolean][] = [
        ["breakfast", args.breakfast],
        ["valet", args.valet],
        ["late_checkout", args.lateCheckout],
        ["pets", args.pets],
      ];
      d.extras = answers.filter(([, wanted]) => wanted).map(([name]) => name);
      d.extrasSet = true;
      requote(hotel, d);
      return {
        recorded:
          d.extras.length > 0 ? d.extras.map((e) => e.replaceAll("_", " ")).join(", ") : "none",
        total: d.quotedTotal === null ? null : `${speakUsd(d.quotedTotal)} including tax`,
        status: bookingStatus(d),
        next: nextStep(d),
      };
    }),
  sendFrom: (result) => ({ type: result.next }),
});
