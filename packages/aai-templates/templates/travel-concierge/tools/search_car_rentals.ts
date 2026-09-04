import { formatMoney } from "@alexkroman1/aai/utils";
import { z } from "zod";
import { CAR_RENTALS, requireDesk, tripSlot } from "../shared.ts";

/** Their `search_car_rentals`, by city and tier. */
export default tripSlot.tool({
  description:
    "The CAR RENTAL DESK's search: cars by city, and optionally by tier (compact, midsize, " +
    "suv). Only usable while the call is at that desk — from anywhere else it refuses, so " +
    "call to_car_rental_assistant first.",
  inputSchema: z.object({
    city: z.string().max(80).describe("City to search, e.g. 'Boston'"),
    tier: z.string().max(40).describe("compact, midsize or suv").optional(),
  }),
  execute(args, trip) {
    const offDesk = requireDesk(trip, "car_rental");
    if (offDesk) return offDesk;
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
        perDay: formatMoney(c.pricePerDay),
      })),
    };
  },
});
