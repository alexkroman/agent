import { agent } from "@alexkroman1/aai";
import { tripSlot, tripView } from "./shared.ts";

/**
 * A phone travel concierge, adapted from LangGraph's customer-support tutorial.
 * `shared.ts` carries the attribution and what changed on the way to voice; the
 * two mechanisms worth reading for are the dialog stack (`routing.ts`) and the
 * confirmation gate (`stageAction` / `confirm_action`).
 *
 * **Every tool in `tools/` belongs to this one agent — the delegation is in the
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
  // One projection replaces a `ctx.send` in each of eleven tools — and is the
  // single place that decides the caller's record leaves the server trimmed.
  syncState: tripSlot.projection(tripView),
  greeting:
    "Swiss Air Travel, this is the concierge desk. I can see your booking — what can I do for you today?",
});
