/** The def a DEPLOYED agent runs: authored, plus what `tools/` and the prompt add. */
import agentDef from "virtual:aai/agent";
// An EVAL: does the host run the game, or play it?
//
// `agent.test.ts` drives the five tools and the round's dialog directly, with a
// scripted player. What no test in it can settle is whether the HOST model
// hands every description to the player rather than guessing itself, starts
// the round when told, and lets the tool — not its own ear — rule on a foul.
//
// Run it with `aai eval`. Without a provider key every case runs against a
// SCRIPTED model (`stubReply` for the host, `stubGenerate` for the player),
// which still boots this agent, still resolves `tools/`, still arms the dialog
// and still executes the tool a script names — so a stub run proves the wiring
// and proves nothing about what the agent chose.
import { dialogResultSchema } from "@alexkroman1/aai/testing";
import { lastStateIn, toolNames, toolResultIn } from "@alexkroman1/aai-runtime/eval";
import { describeEval } from "@alexkroman1/aai-runtime/eval/vitest";
import { expect } from "vitest";
import { z } from "zod";

/** The scoreboard, as these cases read it. */
const Board = z.object({
  phase: z.string(),
  word: z.string().nullable(),
  score: z.number(),
  fouls: z.number(),
  wrongGuesses: z.array(z.string()),
});

/** A scripted player who is always wrong — the word is random, so a script cannot be right. */
const WRONG_PLAYER = ['{"guess":"zebra crossing","remark":"Is it a zebra crossing?"}'];

describeEval(agentDef, (test) => {
  test(
    "'ready' starts the round, and the host reads the intro the tool wrote",
    async ({ session }) => {
      const turn = await session.say("Ready!");
      expect(toolNames(turn.toolCalls)).toEqual(["start_game"]);
      const started = toolResultIn(
        turn.toolCalls,
        "start_game",
        dialogResultSchema(z.object({ word: z.string(), intro: z.string() })),
      );
      expect(started.state).toBe("playing");
      expect(started.result.intro).toMatch(/^Welcome to Word Wrangler!/);
      expect(started.result.intro).toContain(`Here's your first word: ${started.result.word}.`);
      // The describer's screen shows the word and the running round.
      expect(lastStateIn(turn.events, Board)).toMatchObject({
        phase: "playing",
        word: started.result.word,
        score: 0,
      });
    },
    { stubReply: [{ tool: "start_game" }, "Welcome to Word Wrangler! Here's your first word."] },
  );

  test(
    "a description goes to the player, and a wrong guess is relayed without a point",
    async ({ session }) => {
      await session.say("Ready!");
      const turn = await session.say(
        "It's an animal with black and white stripes, lives in Africa.",
      );

      expect(toolNames(turn.toolCalls)).toEqual(["relay_description"]);
      const relayed = toolResultIn(
        turn.toolCalls,
        "relay_description",
        dialogResultSchema(
          z.object({ verdict: z.string(), playerSaid: z.string(), score: z.number() }),
        ),
      );
      expect(relayed.result).toMatchObject({
        verdict: "wrong",
        playerSaid: "Is it a zebra crossing?",
        score: 0,
      });
      // The round is still on: a wrong guess moves nothing.
      expect(relayed.state).toBe("playing");
      expect(lastStateIn(turn.events, Board)).toMatchObject({
        score: 0,
        wrongGuesses: ["zebra crossing"],
      });
    },
    {
      stubReply: [
        { tool: "start_game" },
        "Here's your first word.",
        {
          tool: "relay_description",
          args: { description: "an animal with black and white stripes, lives in Africa" },
        },
        "The player asks: is it a zebra crossing?",
      ],
      stubGenerate: WRONG_PLAYER,
    },
  );

  test(
    "saying the word is a foul the TOOL calls, from the describer's own transcript",
    async ({ session }) => {
      const first = await session.say("Ready!");
      const { word } = toolResultIn(
        first.toolCalls,
        "start_game",
        dialogResultSchema(z.object({ word: z.string() })),
      ).result;
      // The host's relay below is sanitized — the word is not in the script's
      // args — and the tool still rules a foul off what the caller actually said.
      const turn = await session.say(`Okay, my word is ${word}. How would I even describe that?`);

      const relayed = toolResultIn(
        turn.toolCalls,
        "relay_description",
        dialogResultSchema(z.object({ verdict: z.string(), word: z.string(), score: z.number() })),
      );
      expect(relayed.result).toMatchObject({ verdict: "foul", word, score: 0 });
      expect(lastStateIn(turn.events, Board)).toMatchObject({ fouls: 1, score: 0 });
      expect(lastStateIn(turn.events, Board)?.word).not.toBe(word);
    },
    {
      stubReply: [
        { tool: "start_game" },
        "Here's your first word.",
        { tool: "relay_description", args: { description: "how would I even describe that" } },
        "You said the word - that one's forfeited. Your next word is on the screen.",
      ],
      stubGenerate: WRONG_PLAYER,
    },
  );

  test(
    "'skip' is a new word and no point",
    async ({ session }) => {
      const first = await session.say("Ready!");
      const { word } = toolResultIn(
        first.toolCalls,
        "start_game",
        dialogResultSchema(z.object({ word: z.string() })),
      ).result;
      const turn = await session.say("Ugh, skip this one.");
      expect(toolNames(turn.toolCalls)).toEqual(["skip_word"]);
      const board = lastStateIn(turn.events, Board);
      expect(board?.score).toBe(0);
      expect(board?.word).not.toBe(word);
      expect(board?.phase).toBe("playing");
    },
    {
      stubReply: [
        { tool: "start_game" },
        "Here's your first word.",
        { tool: "skip_word" },
        "The new word is on your screen.",
      ],
    },
  );
});
