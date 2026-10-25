import { agent } from "@alexkroman1/aai";
import { gateFlow, tripSlot } from "./shared.ts";

/**
 * A phone travel concierge, adapted from LangGraph's customer-support tutorial.
 * `shared.ts` carries the attribution and what changed on the way to voice; the
 * two mechanisms worth reading for are the dialog stack (`routing.ts`) and the
 * confirmation gate (`stageAction` / `confirm_action`).
 *
 * Their graph gives each specialist node its own bound tool set. A voice
 * session has one model with one tool list for its whole life, so every desk
 * tool declares `require: deskGate(id)` instead — it refuses from any other
 * desk with the `to_…_assistant` to call, so the position the sidebar renders
 * is always the position the work is being done at. The prompt alone was
 * measured losing 0 of 5 live runs (`agent.eval.test.ts`, "a hotel request goes
 * to the hotel desk").
 */
export default agent({
  name: "Swiss Air Concierge",
  listing: "Changes flights, hotels, car rentals and excursions for a booked traveller",
  syncState: tripSlot.projected,
  // Declared so the CALL can move the gate: a caller who hangs up with a
  // change staged leaves the gate on `abandoned`, where nothing may apply it.
  dialogs: [gateFlow],
  // The hang-up's line on the call log is `abandoned`'s own `onEnter`; this
  // is the other thing that happens TO a call rather than in it.
  events: {
    "error.reported": (event, ctx) =>
      tripSlot.update(ctx, (trip) => {
        trip.log.push(
          event.fatal
            ? `Call failed (${event.code}): ${event.message}`
            : `Trouble on the call (${event.code}): ${event.message}`,
        );
      }),
  },
  greeting:
    "Swiss Air Travel, this is the concierge desk. I can see your booking — what can I do for you today?",
});
