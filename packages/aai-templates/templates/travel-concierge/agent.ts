import { agent } from "@alexkroman1/aai";
import { tripProjection } from "./shared.ts";

/**
 * A phone travel concierge, adapted from LangGraph's customer-support tutorial.
 * `shared.ts` carries the attribution and what changed on the way to voice; the
 * two mechanisms worth reading for are the dialog stack (`routing.ts`) and the
 * confirmation gate (`stageAction` / `confirm_action`).
 *
 * **Every tool in `tools/` belongs to this one agent, and the delegation is
 * ENFORCED anyway.** Their graph gives each specialist node its own bound tool
 * set, so a specialist physically cannot call another desk's tools. A voice
 * session has one model with one tool list for its whole life, so a list cannot
 * be narrowed here — but a TOOL can refuse, which is the same guarantee by a
 * route that works mid-call: every desk tool checks the stack first
 * (`requireDesk` in `shared.ts`) and answers a `ToolFailure` naming the
 * `to_…_assistant` to call. So the position the sidebar renders is always the
 * position the work is being done at, and the specialist's brief has always
 * been read before that desk's first search.
 *
 * This used to be asked for in the prompt instead, described here as the honest
 * limit of the port. It was measured and the prompt lost — 0 of 5 live runs, the
 * model searching hotels from the concierge desk every time — so the eval case
 * that predicted it (`agent.eval.test.ts`, "a hotel request goes to the hotel
 * desk") is what turned the narrowing into a mechanism. `complete_or_escalate`
 * is still described the way it is for the other half of the reason: the stack
 * is what the caller and the sidebar can both see.
 */
export default agent({
  name: "Swiss Air Concierge",
  // The stack, the ticket and the itinerary exist before the first tool call,
  // so a resumed connection has something to project.
  // One projection replaces a `ctx.send` in each of eleven tools — and is the
  // single place that decides the caller's record leaves the server trimmed.
  syncState: tripProjection,
  greeting:
    "Swiss Air Travel, this is the concierge desk. I can see your booking — what can I do for you today?",
});
