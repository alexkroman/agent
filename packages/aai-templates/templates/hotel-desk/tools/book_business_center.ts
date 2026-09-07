import { plural } from "@alexkroman1/aai/utils";
import { z } from "zod";
import { BUSINESS_CENTER_SERVICES } from "../catalogs.ts";
import { catalogBookingTool } from "../concierge.ts";
import { speakUsd, spokenDate, spokenTime } from "../records.ts";

/** Their `book_business_center`, as one instance of the catalog factory. */
export default catalogBookingTool({
  description:
    'Book a business-centre service - a meeting room, secretarial help, or a printing job. Look the catalog up first (lookup_policy "business_center") ' +
    "and narrow with the caller - which service, the date and start time, how many hours. THIS CALL is the booking.",
  kind: "business_center",
  prefix: "BIZ",
  inputSchema: z.object({
    service: z.enum(
      Object.keys(BUSINESS_CENTER_SERVICES) as [
        keyof typeof BUSINESS_CENTER_SERVICES,
        ...(keyof typeof BUSINESS_CENTER_SERVICES)[],
      ],
    ),
    date: z.string().describe("YYYY-MM-DD"),
    time: z.string().describe("24-hour HH:MM start"),
    durationHours: z.number().int().min(1).describe("Printing is a flat one-hour job"),
    guestName: z.string().min(1),
    guestPhone: z.string().min(1),
  }),
  price({ service, date, time, durationHours }) {
    const s = BUSINESS_CENTER_SERVICES[service];
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time))
      return { error: "the start time must be 24-hour HH:MM" };
    if (durationHours > s.maxHours)
      return {
        error: `${s.name} is booked for at most ${s.maxHours} ${plural(s.maxHours, "hour")}`,
      };
    const total = s.flatPrice ?? (s.pricePerHour ?? 0) * durationHours;
    return {
      total,
      summary: `${s.name} on ${date} at ${time}, ${durationHours}h`,
      details: { service, time, durationHours },
      confirm:
        `${s.name} booked for ${spokenDate(date)} at ${spokenTime(time)}; total ${speakUsd(total)} (${s.description}). ` +
        "Confirm the service, start time and total.",
    };
  },
});
