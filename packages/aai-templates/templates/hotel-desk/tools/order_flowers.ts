import { z } from "zod";
import { FLORIST_ARRANGEMENTS } from "../catalogs.ts";
import { catalogBookingTool } from "../concierge.ts";
import { speakUsd, spokenDate } from "../records.ts";

/** Their `order_flowers`, as one instance of the catalog factory. */
export default catalogBookingTool({
  description:
    'Order a flower arrangement from the hotel florist for delivery to a room or a recipient. Look the catalog up first (lookup_policy "florist"), ' +
    "let the caller pick, collect the delivery date, where it goes and the gift-card message - read the message back. THIS CALL places the order.",
  kind: "flowers",
  prefix: "FLR",
  inputSchema: z.object({
    arrangement: z.enum(
      Object.keys(FLORIST_ARRANGEMENTS) as [
        keyof typeof FLORIST_ARRANGEMENTS,
        ...(keyof typeof FLORIST_ARRANGEMENTS)[],
      ],
    ),
    date: z.string().describe("Delivery date, YYYY-MM-DD"),
    deliverTo: z
      .string()
      .min(1)
      .describe("A room number or the recipient's name - prefer the room"),
    cardMessage: z.string().max(300).describe("Exactly as the caller dictates it"),
    guestName: z.string().min(1),
    guestPhone: z.string().min(1),
  }),
  price({ arrangement, date, deliverTo, cardMessage }) {
    const a = FLORIST_ARRANGEMENTS[arrangement];
    return {
      total: a.price,
      summary: `${a.name} to ${deliverTo} on ${date}`,
      details: { arrangement, deliverTo, cardMessage },
      confirm:
        `${a.name} ordered for delivery to ${deliverTo} on ${spokenDate(date)}; total ${speakUsd(a.price)}. Confirm the ` +
        "arrangement, where it's going, the date and the total.",
    };
  },
});
