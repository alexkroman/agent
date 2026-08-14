import { tool } from "@alexkroman1/aai";
import { z } from "zod";
import { formatPrice, HOTELS } from "../shared.ts";

/** Their `search_hotels`, with `price_tier` collapsed to a nightly ceiling —
 *  a caller says "under two hundred", not "midscale". */
export const searchHotels = tool({
  description: "Search hotels by city, and optionally by the most they want to pay per night.",
  inputSchema: z.object({
    city: z.string().max(80).describe("City to search, e.g. 'Boston'"),
    maxPerNight: z.number().positive().describe("Nightly ceiling in dollars").optional(),
  }),
  execute(args) {
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
        perNight: formatPrice(h.pricePerNight),
      })),
    };
  },
});
