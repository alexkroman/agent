import { toolFailure } from "@alexkroman1/aai";
import { plural } from "@alexkroman1/aai/utils";
import { z } from "zod";
import { SPA_SERVICES } from "../catalogs.ts";
import { catalogBookingTool } from "../concierge.ts";
import { clockTime, isoDate, speakUsd, spokenDate, spokenTime } from "../records.ts";

/** Their `book_spa_appointment`, as one instance of the catalog factory. */
export default catalogBookingTool({
  description:
    'Book a spa or health-club service (massage, facial, personal training, yoga). Look the catalog up first (lookup_policy "spa") ' +
    "and narrow with the caller - which service, date, start time, party size. THIS CALL is the booking.",
  kind: "spa",
  prefix: "SPA",
  inputSchema: z.object({
    service: z.enum(
      Object.keys(SPA_SERVICES) as [keyof typeof SPA_SERVICES, ...(keyof typeof SPA_SERVICES)[]],
    ),
    date: isoDate("the appointment date"),
    time: clockTime("the start time"),
    partySize: z.number().int().min(1),
    guestName: z.string().min(1),
    guestPhone: z.string().min(1),
  }),
  price({ service, date, time, partySize }) {
    const s = SPA_SERVICES[service];
    if (partySize > s.maxParty)
      return toolFailure(`${s.name} takes at most ${s.maxParty} ${plural(s.maxParty, "guest")}`);
    const total = s.price * partySize;
    return {
      total,
      summary: `${s.name} for ${partySize} on ${date} at ${time}`,
      details: { service, time, partySize, durationMin: s.durationMin },
      confirm:
        `${s.name} booked for ${partySize} on ${spokenDate(date)} at ${spokenTime(time)}; ${s.durationMin} minutes, ` +
        `total ${speakUsd(total)} (${s.description}). Confirm the service, date, time and total.`,
    };
  },
});
