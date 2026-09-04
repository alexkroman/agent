import { formatMoney } from "@alexkroman1/aai/utils";
import { z } from "zod";
import { HOTELS, requireDesk, tripSlot } from "../shared.ts";

/** Their `search_hotels`, with `price_tier` collapsed to a nightly ceiling —
 *  a caller says "under two hundred", not "midscale". */
export default tripSlot.tool({
  description:
    "The HOTEL DESK's search: hotels by city, and optionally by the most they want to pay " +
    "per night. Only usable while the call is at that desk — from anywhere else it refuses, " +
    "so call to_hotel_assistant first.",
  inputSchema: z.object({
    city: z.string().max(80).describe("City to search, e.g. 'Boston'"),
    maxPerNight: z.number().positive().describe("Nightly ceiling in dollars").optional(),
  }),
  execute(args, trip) {
    const offDesk = requireDesk(trip, "hotel");
    if (offDesk) return offDesk;
    const city = args.city.trim().toLowerCase();
    const hotels = HOTELS.filter(
      (h) =>
        h.city.toLowerCase().includes(city) &&
        (args.maxPerNight === undefined || h.pricePerNight <= args.maxPerNight),
    ).sort((a, b) => a.pricePerNight - b.pricePerNight);
    if (hotels.length === 0) {
      return {
        hotels: [],
        message: `Nothing in ${args.city} under that price. Cities covered: ${[...new Set(HOTELS.map((h) => h.city))].join(", ")}.`,
      };
    }
    return {
      hotels: hotels.map((h) => ({
        id: h.id,
        name: h.name,
        area: h.area,
        stars: h.stars,
        perNight: formatMoney(h.pricePerNight),
      })),
    };
  },
});
