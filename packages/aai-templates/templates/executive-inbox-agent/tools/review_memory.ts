import { EXECUTIVE } from "../inbox.ts";
import { assistantSlot } from "../shared.ts";

/**
 * What the assistant has learned — the four memory prompts their store holds,
 * and every rewrite this call made to them. A read, so ungated: "what have you
 * picked up about how I write?" is answerable at any point.
 */
export default assistantSlot.tool({
  description:
    `Read back what you currently believe about how ${EXECUTIVE.name} likes emails written, ` +
    "what to include, how to schedule, and the background you are working from — plus what " +
    "you learned on this call. For when they ask what you have picked up, or to check a rule.",
  execute: (_args, state) => ({
    tone: state.memory.rewriteInstructions,
    content: state.memory.responsePreferences || "(nothing yet)",
    scheduling: state.memory.schedulePreferences,
    background: state.memory.backgroundPreferences,
    learnedThisCall: state.reflections.map((r) => `${r.memory}: ${r.logic}`),
    examplesRemembered: state.triageExamples.length,
  }),
});
