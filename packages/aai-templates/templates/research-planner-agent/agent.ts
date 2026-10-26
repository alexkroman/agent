import { agent } from "@alexkroman1/aai";

/**
 * A planning desk you can phone: plan-and-execute, with the caller in the loop.
 * `prompts.ts` carries the attribution, `procedure.ts` the three nodes, `shared.ts`
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
  // It says the LOOP rather than "research", because a caller who wants an
  // answer in one turn is on the wrong line.
  listing: "Turns an objective into a plan and works it one step at a time with the caller",
  greeting: "Planning desk. Tell me what you're trying to get done and I'll work out the steps.",
});
