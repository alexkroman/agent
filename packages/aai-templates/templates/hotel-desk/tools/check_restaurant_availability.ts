import { toolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { openDinnerSlots } from "../hotel.ts";
import { isIsoDate, MAX_PARTY_SIZE, spokenDate, spokenTime } from "../records.ts";
import { hotelSlot } from "../shared.ts";

/** Their `check_restaurant_availability`: the open slots for a date and party. */
export default hotelSlot.tool({
  description:
    "Check the restaurant's open time slots for a date and party size. Read-only - to book a " +
    "table call reserve_table. Offer the times and let the caller pick; never choose one yourself.",
  inputSchema: z.object({
    date: z.string().describe("YYYY-MM-DD"),
    partySize: z.number().int().min(1).max(MAX_PARTY_SIZE),
  }),
  execute({ date, partySize }, hotel) {
    if (!isIsoDate(date)) return toolFailure("the date must be YYYY-MM-DD");
    const open = openDinnerSlots(hotel, date, partySize);
    if (open.length === 0)
      return {
        open: [],
        message: `Fully booked on ${spokenDate(date)} for a party of ${partySize}.`,
      };
    return { date: spokenDate(date), open: open.map(spokenTime) };
  },
});
