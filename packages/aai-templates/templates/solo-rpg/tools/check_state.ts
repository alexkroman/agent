import { gameSlot, stateSummary } from "../shared.ts";

// `gameSlot.tool`, the READING half: the body is handed the value, so it needs
// neither a context annotation nor an opening `gameSlot.get(ctx)` — and what it
// is handed is deep-frozen, which is what makes "this tool only reads" a
// property of the declaration rather than a claim in a comment.
export default gameSlot.tool({
  description:
    "Returns the full current game state. Call this at the start of every turn, before narrating or rolling, and treat the returned values as ground truth — never guess or remember stats from previous turns.",
  execute: (_args, game) => stateSummary(game),
});
