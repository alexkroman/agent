import { tool } from "@alexkroman1/aai";
import { z } from "zod";
import { CAR_RENTALS, formatPrice } from "../shared.ts";

/** Their `search_car_rentals`, by city and tier. */
export default tool({
  description: "Search rental cars by city, and optionally by tier (compact, midsize, suv).",
  inputSchema: z.object({
    city: z.string().max(80).describe("City to search, e.g. 'Boston'"),
    tier: z.string().max(40).describe("compact, midsize or suv").optional(),
  }),
  execute(args) {
    const city = args.city.trim().toLowerCase();
    const tier = args.tier?.trim().toLowerCase();
    const cars = CAR_RENTALS.filter(
      (c) => c.city.toLowerCase().includes(city) && (!tier || c.tier === tier),
    ).sort((a, b) => a.pricePerDay - b.pricePerDay);
    if (cars.length === 0) {
      return {
        cars: [],
        message: `No ${tier ?? "cars"} in ${args.city}. Cities covered: ${[...new Set(CAR_RENTALS.map((c) => c.city))].join(", ")}.`,
      };
    }
    return {
      cars: cars.map((c) => ({
        id: c.id,
        vendor: c.vendor,
        tier: c.tier,
        perDay: formatPrice(c.pricePerDay),
      })),
    };
  },
});
