/**
 * One tool shape for the four concierge catalogs.
 *
 * Their `book_tour`, `book_spa_appointment`, `book_business_center` and
 * `order_flowers` are four `@function_tool`s that differ in which catalog they
 * read, how the total is computed and which extra fields the booking takes —
 * and share everything else: the past-date check, the party cap, the code, the
 * "confirm the fixed details, no further call is needed" directive. The
 * FACTORY holds the shared half and each `tools/` file names one instance,
 * the way `travel-concierge`'s delegation tools do.
 */

import type { InferSchemaOutput, ToolDef } from "@alexkroman1/aai";
import { toolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import {
  digitsOf,
  isIsoDate,
  speakCode,
  speakUsd,
  spokenDate,
  type Ticket,
  TODAY,
} from "./records.ts";
import { addTicket, hotelSlot } from "./shared.ts";

export interface CatalogBookingSpec<P extends z.ZodObject> {
  description: string;
  inputSchema: P;
  kind: Ticket["kind"];
  prefix: string;
  /**
   * Price and describe one booking from its arguments, or refuse it. `date` is
   * already known to be a real, future date; the cap on party size or hours is
   * the catalog's own and is checked here.
   */
  price(
    args: InferSchemaOutput<P>,
  ):
    | { total: number; summary: string; details: Ticket["details"]; confirm: string }
    | { error: string };
}

/**
 * Every catalog booking carries a date, a guest name and a phone. Parsed back
 * out of the arguments rather than asserted: a catalog whose schema dropped one
 * of the three fails its first call naming the field, instead of booking with
 * `undefined` for a date.
 */
const COMMON = z.object({ date: z.string(), guestName: z.string(), guestPhone: z.string() });

export function catalogBookingTool<P extends z.ZodObject>(spec: CatalogBookingSpec<P>): ToolDef {
  return hotelSlot.updateTool({
    description: spec.description,
    inputSchema: spec.inputSchema,
    execute(args, hotel) {
      const common = COMMON.parse(args);
      if (!isIsoDate(common.date))
        return toolFailure(`${common.date} is not a date - use YYYY-MM-DD`);
      if (common.date < TODAY)
        return toolFailure(`${spokenDate(common.date)} is in the past - re-confirm the date`);
      const priced = spec.price(args);
      if ("error" in priced) return toolFailure(priced.error);
      const ticket = addTicket(hotel, spec.kind, spec.prefix, priced.summary, {
        ...priced.details,
        guestName: common.guestName,
        guestPhone: digitsOf(common.guestPhone) || common.guestPhone,
        date: common.date,
        total: priced.total,
      });
      return {
        reference: ticket.code,
        spokenReference: speakCode(ticket.code),
        date: spokenDate(common.date),
        total: speakUsd(priced.total),
        booked: priced.summary,
        next:
          `${priced.confirm} These are fixed - give them as facts; no further tool call is needed ` +
          "for this booking.",
      };
    },
  });
}
