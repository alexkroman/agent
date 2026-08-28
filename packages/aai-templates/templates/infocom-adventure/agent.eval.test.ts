/// <reference types="vite/client" />

// An EVAL: does the game engine actually keep its world? Run it with `aai eval`.
//
// `agent.test.ts` drives the tools directly, one call at a time, against a
// context it made itself. This drives the AGENT: a real session, the real tool
// executor, the real event stream, and — the part no unit test can reach — MORE
// THAN ONE TURN through the same session slot. Everything worth asserting here
// is a claim about state that has to survive a turn boundary, or about the world
// really being replaced when the player asks to start over.
//
// Two modes, and `describeEval` announces which it picked:
//
//   * with ASSEMBLYAI_API_KEY — a LIVE model. It really has to map "I pick up
//     the rusted lantern" onto `game_state_take`, which is the behaviour the
//     system prompt spends a whole section on.
//   * without one — a SCRIPTED model, whose tool calls REALLY EXECUTE. The
//     state changes for real, so a scripted take followed by a scripted read is
//     a genuine two-turn state test with no model involved.
//
// What no eval here can see: anything below the audio boundary — endpointing,
// barge-in, two commands merging into one turn. Those need real paced audio.

import { deployedAgent } from "@alexkroman1/aai/testing";
import { type EvalTurn, toolResultIn } from "@alexkroman1/aai-runtime/eval";
import { describeEval } from "@alexkroman1/aai-runtime/eval/vitest";
import { expect } from "vitest";
import { z } from "zod";
import authoredAgent from "./agent.ts";
import { DEFAULT_GAME_STATE } from "./shared.ts";
import systemPrompt from "./system-prompt.md?raw";

/**
 * The def a DEPLOYED agent runs, assembled the way the build assembles it: the
 * authored export, plus what `tools/` declares, plus `system-prompt.md`.
 *
 * Both wrappers matter here in a way they do not in `agent.test.ts`. A tool
 * missing from the registry is a tool the model cannot call, and the prompt is
 * the only thing that tells a live model that "grab the rope" means
 * `game_state_take` — an eval run against the framework default prompt measures
 * an agent nobody deployed.
 */
const agentDef = deployedAgent(authoredAgent, {
  tools: import.meta.glob("./tools/*.ts", { eager: true }),
  systemPrompt: systemPrompt,
});

/**
 * What each of the three tools this file drives answers, off the wire.
 *
 * `tool.completed` carries a tool result as a JSON STRING, so a case either
 * casts it or validates it — and a cast is silent exactly when a tool's result
 * changed shape underneath the eval, which is the regression an eval exists to
 * catch. `toolResultIn` takes a schema for that reason, and these name only the
 * fields asserted below.
 */
const Carried = z.object({ inventory: z.array(z.string()) });
const Restarted = z.object({ restarted: z.boolean() });
const Status = z.object({
  inventory: z.array(z.string()),
  score: z.number(),
  moves: z.number(),
  currentRoom: z.string(),
});

/**
 * What the ONE call to `name` answered on this turn.
 *
 * `toolResultIn` is the SDK's reader: it throws rather than returning
 * undefined, and names what the agent called instead — "it called a different
 * tool" is the finding, and a case that read `undefined` off a missing call
 * would assert against nothing. A turn that called it TWICE is refused too,
 * rather than silently answered with the first.
 */
const answerOf = <T>(turn: EvalTurn, name: string, schema: z.ZodType<T>): T =>
  toolResultIn(turn.toolCalls, name, schema);

describeEval(agentDef, (test) => {
  test(
    "an item taken on one turn is still carried on the next",
    async ({ session }) => {
      const taken = await session.say("I pick up the rusted lantern.");
      // The write really wrote. `game_state_take` is a `gameSlot.updateTool`,
      // and it shipped once as the READING half — pushing to a deep-frozen
      // array, which throws on every call. A tool that threw answers with an
      // error here, not an inventory.
      expect(answerOf(taken, "game_state_take", Carried).inventory).toContain("rusted lantern");

      // A SECOND turn, which is the whole point: the slot is keyed per session,
      // so this is the only place the take can be shown to have outlived the
      // turn that made it.
      const status = await session.say("Check the game state. What am I carrying?");
      expect(answerOf(status, "game_state_get", Status).inventory).toContain("rusted lantern");
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
      expect(answerOf(taken, "game_state_take", Carried).inventory).toContain("rusted lantern");

      const again = await session.say("Forget all that. Start a new game from the beginning.");
      expect(answerOf(again, "game_state_restart", Restarted).restarted).toBe(true);

      // `game_state_restart` is the one tool that REPLACES the slot's value
      // (`gameSlot.reset`), so what has to be checked is the state a LATER turn
      // reads — a reset that only rebuilt the value it returned would satisfy
      // the assertion above and leave the lantern in the player's hands.
      const status = await session.say("Check the game state. What am I carrying, and where am I?");
      const fresh = answerOf(status, "game_state_get", Status);
      expect(fresh.inventory).toEqual([]);
      expect(fresh.score).toBe(0);
      expect(fresh.currentRoom).toBe(DEFAULT_GAME_STATE.currentRoom);
      // ONE, not zero — and this is the assertion that proves the turn counter
      // is the framework's. The reset emptied it, then the player said the line
      // above, and the `user-transcript.committed` hook counted it before the
      // narrator took its turn. No tool call is involved anywhere in that.
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
    "a restart is narrated, not merely recorded",
    async ({ session }) => {
      // LIVE only: the claim is about what the narrator SAYS after the reset,
      // and a scripted reply is a line this file wrote. The prompt asks for the
      // opening scene again — a restart that answers "done" leaves a voice
      // player with no idea where they are.
      const again = await session.say("Start over. New game, please.");

      expect(answerOf(again, "game_state_restart", Restarted).restarted).toBe(true);
      expect(again.text).toMatch(/cave|cavern|forest|entrance|lantern/i);
      expect(again.completed).toBe(true);
    },
    { live: true },
  );
});
