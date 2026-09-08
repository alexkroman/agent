import { toolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { describeRoomOptions, listRoomOptions } from "../hotel.ts";
import { isoDate, MAX_PARTY_SIZE, ROOM_TYPES, spokenDate } from "../records.ts";
import { hotelSlot } from "../shared.ts";

/** Their `check_room_availability`: read-only browsing, never a booking. */
export default hotelSlot.tool({
  description:
    "Check what's available for a date range, with rates and views - the one tool for \"what do you " +
    'have?", "how much?", "any king free?". Read-only: when the caller wants to book, call ' +
    "start_room_booking instead. Surface results progressively (types first, details once they narrow).",
  inputSchema: z.object({
    checkIn: isoDate("the check-in date"),
    checkOut: isoDate("the check-out date"),
    guests: z.number().int().min(1).max(MAX_PARTY_SIZE).describe("Ask if not said"),
    smoking: z.enum(["smoking", "non_smoking", "no_preference"]).optional(),
    roomType: z.enum([...ROOM_TYPES, "any"]).optional(),
  }),
  execute({ checkIn, checkOut, guests, smoking = "no_preference", roomType = "any" }, hotel) {
    if (checkOut <= checkIn) return toolFailure("check-out must be after check-in");
    const smokingFilter =
      smoking === "smoking" ? true : smoking === "non_smoking" ? false : undefined;
    let options = listRoomOptions(hotel, { checkIn, checkOut, guests, smoking: smokingFilter });
    if (roomType !== "any") options = options.filter((o) => o.type === roomType);
    const window = `${spokenDate(checkIn)} to ${spokenDate(checkOut)}`;
    if (options.length === 0) {
      const kind =
        smokingFilter === true ? "smoking " : smokingFilter === false ? "non-smoking " : "";
      const what = roomType === "any" ? `${kind}rooms` : `${kind}${roomType.replaceAll("_", " ")}`;
      return {
        available: false,
        message:
          `No ${what} available ${window}. Be honest it's full and offer the nights either side; ` +
          "if they want to be told should a room open up, add_to_waitlist.",
      };
    }
    return { available: true, window, options: describeRoomOptions(options) };
  },
});
