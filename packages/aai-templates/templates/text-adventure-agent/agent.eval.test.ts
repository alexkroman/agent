// An EVAL: does the game engine actually keep its world? Run it with `aai eval`.
//
// `agent.test.ts` drives the tools one call at a time. This drives the AGENT —
// a real session, the real tool executor, and MORE THAN ONE TURN through the
// same session slot, which is the part no unit test can reach. With a key it
// is a live model that has to map "I pick up the rusted lantern" onto
// `game_state_take`; without one a scripted model whose tool calls really
// execute, so a scripted take followed by a scripted read is still a two-turn
// state test.
import agentDef from "virtual:aai/agent";
import { expectToolOk } from "@alexkroman1/aai-runtime/testing";
import {
  describeEval,
  lastToolResultIn,
  toolCallsInTurns,
  toolResultIn,
} from "@alexkroman1/aai-runtime/testing/vitest";
import { expect } from "vitest";
import { DEFAULT_GAME_STATE, rankFor } from "./shared.ts";
import gameStateGet from "./tools/game_state_get.ts";
import gameStateRestart from "./tools/game_state_restart.ts";
import gameStateScore from "./tools/game_state_score.ts";
import gameStateTake from "./tools/game_state_take.ts";

describeEval(agentDef, (test) => {
  test(
    "an item taken on one turn is still carried on the next",
    async ({ session }) => {
      const taken = await session.say("I pick up the rusted lantern.");
      expect(toolResultIn(taken.toolCalls, gameStateTake).inventory).toContain("rusted lantern");

      // A SECOND turn: the slot is keyed per session, so this is the only
      // place the take can be shown to have outlived the turn that made it.
      const status = await session.say("Check the game state. What am I carrying?");
      expect(toolResultIn(status.toolCalls, gameStateGet).inventory).toContain("rusted lantern");
      expect(status.completed).toBe(true);
    },
    {
      stubReply: [
        { tool: "game_state_take", args: { value: "rusted lantern" } },
        "You lift the rusted lantern from its iron hook. It is heavier than it looks.",
        { tool: "game_state_get" },
        "You are carrying the rusted lantern, and nothing else.",
      ],
    },
  );

  test(
    "starting over really empties the world",
    async ({ session }) => {
      const taken = await session.say("I pick up the rusted lantern.");
      expect(toolResultIn(taken.toolCalls, gameStateTake).inventory).toContain("rusted lantern");

      const again = await session.say("Forget all that. Start a new game from the beginning.");
      expect(toolResultIn(again.toolCalls, gameStateRestart).restarted).toBe(true);

      // What a LATER turn reads: a reset that only rebuilt the value it
      // returned would leave the lantern in the player's hands.
      const status = await session.say("Check the game state. What am I carrying, and where am I?");
      const fresh = toolResultIn(status.toolCalls, gameStateGet);
      expect(fresh.inventory).toEqual([]);
      expect(fresh.score).toBe(0);
      expect(fresh.currentRoom).toBe(DEFAULT_GAME_STATE.currentRoom);
      // ONE, not zero: the reset emptied it, then the player said the line
      // above and the hook counted it before the narrator took its turn.
      expect(fresh.moves).toBe(1);
    },
    {
      stubReply: [
        { tool: "game_state_take", args: { value: "rusted lantern" } },
        "You lift the rusted lantern from its iron hook.",
        { tool: "game_state_restart" },
        "Very well. We begin again at the mouth of the cave.",
        { tool: "game_state_get" },
        "You carry nothing. Your score is zero, and you stand at the cave mouth.",
      ],
    },
  );

  test(
    "the rank the score earned is still the player's rank a turn later",
    async ({ session }) => {
      // The chalice has to be IN HAND first and REACHABLE: the prompt pins it
      // to the Pine Forest, the one treasure above ground, so a live narrator
      // can score a return without the puzzles it invents underground.
      const turns = await session.sayAll([
        "I walk into the Pine Forest.",
        "I pick up the golden chalice.",
        "I carry the chalice back to the Cave Mouth.",
        "I set the chalice on the stone pedestal. Award me the points for returning it.",
      ]);
      // `lastToolResultIn`: across three turns a live narrator may award twice,
      // and the SETTLED total is the one the player was told.
      const earned = expectToolOk(lastToolResultIn(toolCallsInTurns(turns), gameStateScore));
      // Whatever was awarded, the rank that came back is the one the ladder
      // says that score earns — reported off the stored game, not the draft.
      expect(earned.rank).toBe(rankFor(earned.score));

      const later = toolResultIn(
        (await session.say("Check the game state.")).toolCalls,
        gameStateGet,
      );
      expect(later.score).toBe(earned.score);
      expect(later.rank).toBe(earned.rank);
    },
    {
      stubReply: [
        { tool: "game_state_move", args: { value: "Pine Forest" } },
        "Pines crowd close, and something gold glints among the roots.",
        { tool: "game_state_take", args: { value: "golden chalice" } },
        "The golden chalice is cool and heavier than it looks.",
        { tool: "game_state_move", args: { value: "Cave Mouth" } },
        "You retrace your steps to the cave mouth, chalice in hand.",
        { tool: "game_state_score", args: { value: 30 } },
        "The chalice settles onto the pedestal with a satisfying weight.",
        { tool: "game_state_get" },
        "Thirty points, which makes you an Amateur Adventurer.",
      ],
    },
  );

  test(
    "a restart is narrated, not merely recorded",
    async ({ session }) => {
      // LIVE only: the claim is about what the narrator SAYS after the reset.
      const again = await session.say("Start over. New game, please.");
      expect(toolResultIn(again.toolCalls, gameStateRestart).restarted).toBe(true);
      expect(again.text).toMatch(/cave|cavern|forest|entrance|lantern/i);
      expect(again.completed).toBe(true);
    },
    { live: true },
  );
});
