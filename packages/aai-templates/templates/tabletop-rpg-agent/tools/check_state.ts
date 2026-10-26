import { gameSlot, stateSummary, storyFlow } from "../shared.ts";

/**
 * Legal in every state — "there is no campaign yet" is a thing the narrator
 * may need said back — and the one tool that reports the POSITION beside the
 * campaign, so "there is no character yet" is the same fact here as the
 * refusal `action_roll` would give.
 *
 * Not called every turn: the tracks, momentum, clocks and cast ride in the
 * prompt (`liveSheet`). This is for the chronicle, the whole NPC records, the
 * blueprint, and the position on demand.
 */
export default gameSlot.tool({
  description:
    "Returns the FULL current game state — including the chronicle, the whole NPC records and the story blueprint — and where the story is. The tracks, momentum, clocks and cast are already in your instructions and refreshed every turn, so reach for this when you want the rest of the board or the position restated, not as a matter of routine.",
  dialog: storyFlow,
  execute: (_args, game) => stateSummary(game),
});
