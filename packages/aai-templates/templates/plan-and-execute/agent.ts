import { agent } from "@alexkroman1/aai";
import { planProjection } from "./shared.ts";

/**
 * A planning desk you can phone: plan-and-execute, with the caller in the loop.
 * `prompts.ts` carries the attribution, `graph.ts` the three nodes, `shared.ts`
 * the state (which is their `PlanExecute`, field for field).
 *
 * **The steps do real work.** `work_next_step` runs a bounded search/answer loop
 * on `webSearch` — the same DuckDuckGo-backed implementation behind the
 * `web_search` builtin, no API key — so a plan about anything current is worked
 * against what is actually out there rather than against what a model
 * remembers. That is the difference between this and a template that "plans" by
 * asking a model to imagine having looked something up.
 */
export default agent({
  name: "Planning Desk",
  // The plan exists before the first tool call, so a resumed connection has
  // something to project.
  // The plan, its progress and its revision trail, pushed after every tool call.
  syncState: planProjection,
  greeting: "Planning desk. Tell me what you're trying to get done and I'll work out the steps.",
});
