import { tool } from "@alexkroman1/aai";
import { z } from "zod";
import { EXCURSIONS, formatPrice } from "../shared.ts";

/** Their `search_trip_recommendations` — city plus a loose keyword, matched
 *  against the name and the kind so "boat" and "sail" both land. */
export default tool({
  description: "Find things to do in a city. The keyword is optional and matched loosely.",
  inputSchema: z.object({
    city: z.string().max(80).describe("City to search, e.g. 'Boston'"),
    keyword: z
      .string()
      .max(60)
      .describe("What they enjoy, e.g. 'food', 'boat', 'history'")
      .optional(),
  }),
  execute(args) {
    const city = args.city.trim().toLowerCase();
    const keyword = args.keyword?.trim().toLowerCase();
    const inCity = EXCURSIONS.filter((e) => e.city.toLowerCase().includes(city));
    const matched = keyword
      ? inCity.filter((e) => e.kind.includes(keyword) || e.name.toLowerCase().includes(keyword))
      : inCity;
    // A keyword that matches nothing falls back to the city rather than to
    // silence — the desk should still have something to offer.
    const results = matched.length > 0 ? matched : inCity;
    return {
      widened: keyword !== undefined && matched.length === 0 && inCity.length > 0,
      excursions: results.map((e) => ({
        id: e.id,
        name: e.name,
        kind: e.kind,
        price: formatPrice(e.price),
      })),
    };
  },
});
