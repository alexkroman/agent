import { gameSlot, stateSummary, storyFlow } from "../shared.ts";

/**
 * `gameSlot.tool`, the READING half: the body is handed the value, so it needs
 * neither a context annotation nor an opening `gameSlot.get(ctx)` — and what it
 * is handed is deep-frozen, which is what makes "this tool only reads" a
 * property of the declaration rather than a claim in a comment.
 *
 * **Legal in every state, which is why it is not a `storyFlow.tool`** — it is
 * answerable before a character exists, and "there is no campaign yet" is a
 * thing the narrator may need said back. It is also the one tool that reports
 * the POSITION, the way `research-planner-agent`'s `plan_status` does: the
 * position comes from the machine rather than from a second reading of the
 * campaign's fields, so "there is no character yet" is the same fact here as the
 * refusal `action_roll` would give.
 *
 * **It is no longer called every turn, and that is the point of `liveSheet`.**
 * The prompt used to open every turn with this call — a full model round trip
 * before a word of narration, on a live voice game — because the tracks and the
 * clocks reached the model no other way. They ride in the system prompt now
 * (`agent.ts`'s `systemPrompt` resolver), so what is left here is the half a
 * sheet cannot carry on every request: the chronicle, the whole NPC records,
 * the story blueprint, and the position on demand.
 */
export default gameSlot.tool({
  description:
    "Returns the FULL current game state — including the chronicle, the whole NPC records and the story blueprint — and where the story is. The tracks, momentum, clocks and cast are already in your instructions and refreshed every turn, so reach for this when you want the rest of the board or the position restated, not as a matter of routine.",
  execute: (_args, game, ctx) => ({
    // The position SPREAD rather than renamed. `at`/`next`/`storyOver` said the
    // same three things a gated tool's result already carries as `state`,
    // `instruction` and `done` — so within one agent the model was reading its
    // own position under two key sets, and the system prompt's claim that
    // "every other tool answers with the same pair" was simply false.
    ...storyFlow.position(ctx),
    ...stateSummary(game),
  }),
});
