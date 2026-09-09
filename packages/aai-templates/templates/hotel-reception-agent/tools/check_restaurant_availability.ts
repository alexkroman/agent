import { z } from "zod";
import { isoDate, MAX_PARTY_SIZE, spokenDate, spokenTime } from "../records.ts";
import { openDinnerSlots } from "../restaurant.ts";
import { hotelSlot } from "../session.ts";

/** Their `check_restaurant_availability`: the open slots for a date and party. */
export default hotelSlot.tool({
  description:
    "Check the restaurant's open time slots for a date and party size. Read-only - to book a " +
    "table call reserve_table. Offer the times and let the caller pick; never choose one yourself.",
  inputSchema: z.object({
    date: isoDate("the date"),
    partySize: z.number().int().min(1).max(MAX_PARTY_SIZE),
  }),
  execute({ date, partySize }, hotel) {
    const open = openDinnerSlots(hotel, date, partySize);
    if (open.length === 0)
      return {
        open: [],
        message: `Fully booked on ${spokenDate(date)} for a party of ${partySize}.`,
      };
    return { date: spokenDate(date), open: open.map(spokenTime) };
  },
});
