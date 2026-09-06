import { z } from "zod";
import { TOURS } from "../catalogs.ts";
import { catalogBookingTool } from "../concierge.ts";
import { speakUsd, spokenDate, spokenTime } from "../records.ts";

/** Their `book_tour`, as one instance of the catalog factory. */
export default catalogBookingTool({
  description:
    'Book a sightseeing tour through the desk. Look the catalog up first (lookup_policy "tours") and narrow ' +
    "with the caller - group or private, half or full day, date, party size. THIS CALL is the booking: " +
    'saying "I\'ll get that set up" books nothing.',
  kind: "tour",
  prefix: "TUR",
  inputSchema: z.object({
    tour: z.enum(Object.keys(TOURS) as [keyof typeof TOURS, ...(keyof typeof TOURS)[]]),
    date: z.string().describe("YYYY-MM-DD"),
    partySize: z.number().int().min(1),
    guestName: z.string().min(1),
    guestPhone: z.string().min(1),
  }),
  price({ tour, date, partySize }) {
    const t = TOURS[tour];
    if (partySize > t.maxParty) return { error: `${t.name} takes at most ${t.maxParty} guests` };
    const total = t.flatPrice ?? (t.pricePerPerson ?? 0) * partySize;
    return {
      total,
      summary: `${t.name} for ${partySize} on ${date}`,
      details: { tour, partySize, pickupTime: t.pickupTime },
      confirm:
        `${t.name} booked for ${partySize} on ${spokenDate(date)}. Pickup ${spokenTime(t.pickupTime)} at the ` +
        `${t.pickupLocation}; total ${speakUsd(total)} (${t.description}). Confirm the pickup time, spot and total.`,
    };
  },
});
