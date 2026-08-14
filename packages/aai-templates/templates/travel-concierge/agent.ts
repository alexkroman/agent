import { agent } from "@alexkroman1/aai";
import { cancelAction, completeOrEscalate, confirmAction, delegationTools } from "./routing.ts";
import { tripSlot, tripView } from "./shared.ts";
import systemPrompt from "./system-prompt.md?raw";
import { bookCarRental } from "./tools/book_car_rental.ts";
import { bookExcursion } from "./tools/book_excursion.ts";
import { bookHotel } from "./tools/book_hotel.ts";
import { cancelTicket } from "./tools/cancel_ticket.ts";
import { lookupBooking } from "./tools/lookup_booking.ts";
import { searchCarRentals } from "./tools/search_car_rentals.ts";
import { searchExcursions } from "./tools/search_excursions.ts";
import { searchFlights } from "./tools/search_flights.ts";
import { searchHotels } from "./tools/search_hotels.ts";
import { updateTicket } from "./tools/update_ticket.ts";

/**
 * A phone travel concierge, adapted from LangGraph's customer-support tutorial.
 * `shared.ts` carries the attribution and what changed on the way to voice; the
 * two mechanisms worth reading for are the dialog stack (`routing.ts`) and the
 * confirmation gate (`stageAction` / `confirm_action`).
 *
 * **Every tool is declared here, on one agent — the delegation is in the
 * PROMPT, not in the tool list.** Their graph gives each specialist node its
 * own bound tool set, so a specialist physically cannot call another desk's
 * tools. A voice session has one model with one tool list for its whole life,
 * so the specialist's brief arrives as a tool result and the narrowing is
 * something the model is asked to honour rather than something the runtime
 * enforces. That is the honest limit of the port, and it is why
 * `complete_or_escalate` is described the way it is: the stack is what the
 * caller and the sidebar can both see, even when the model reaches past it.
 */
export default agent({
  name: "Swiss Air Concierge",
  // The stack, the ticket and the itinerary exist before the first tool call,
  // so a resumed connection has something to project.
  state: tripSlot.state,
  // One projection replaces a `ctx.send` in each of eleven tools — and is the
  // single place that decides the caller's record leaves the server trimmed.
  syncState: tripSlot.projection(tripView),
  systemPrompt,
  greeting:
    "Swiss Air Travel, this is the concierge desk. I can see your booking — what can I do for you today?",

  tools: {
    // The control plane: push a desk, pop back, apply or drop a staged change.
    ...delegationTools,
    complete_or_escalate: completeOrEscalate,
    confirm_action: confirmAction,
    cancel_action: cancelAction,

    // Read-only, so no gate.
    lookup_booking: lookupBooking,
    search_flights: searchFlights,
    search_hotels: searchHotels,
    search_car_rentals: searchCarRentals,
    search_excursions: searchExcursions,

    // Sensitive: each of these STAGES a change and applies nothing.
    update_ticket: updateTicket,
    cancel_ticket: cancelTicket,
    book_hotel: bookHotel,
    book_car_rental: bookCarRental,
    book_excursion: bookExcursion,
  },
});
