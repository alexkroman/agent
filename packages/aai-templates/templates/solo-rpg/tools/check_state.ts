import { gameSlot, stateSummary, storyFlow } from "../shared.ts";

/**
 * `gameSlot.tool`, the READING half: the body is handed the value, so it needs
 * neither a context annotation nor an opening `gameSlot.get(ctx)` — and what it
 * is handed is deep-frozen, which is what makes "this tool only reads" a
 * property of the declaration rather than a claim in a comment.
 *
 * **Legal in every state, which is why it is not a `storyFlow.tool`** — the
 * prompt says to call it FIRST every turn, and that includes the turn before a
 * character exists. It is also the one tool that reports the POSITION, the way
 * `plan-and-execute`'s `plan_status` does: the position comes from the machine
 * rather than from a second reading of the campaign's fields, so "there is no
 * character yet" is the same fact here as the refusal `action_roll` would give.
 */
export default gameSlot.tool({
  description:
    "Returns the full current game state, and where the story is. Call this at the start of every turn, before narrating or rolling, and treat the returned values as ground truth — never guess or remember stats from previous turns.",
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
