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
    async ({ session, mode }) => {
      await session.say("Ready!");
      const turn = await session.say(
        "It's an animal with black and white stripes, lives in Africa.",
      );

      expect(toolNames(turn.toolCalls)).toEqual(["relay_description"]);
      const relayed = toolResultIn(
        turn.toolCalls,
        "relay_description",
        dialogResultSchema(
          z.object({
            verdict: z.string(),
            playerSaid: z.string(),
            guess: z.string(),
            score: z.number(),
          }),
        ),
      );
      // The player really answered, and the host relayed rather than ruling on
      // the guess itself — the claim in this case's name, and the half that
      // holds in either mode.
      expect(relayed.result.playerSaid.length).toBeGreaterThan(0);
      // WHICH verdict came back is the game's business, not this case's: the
      // word is drawn at random and `zebra` is in the pool, so live — where a
      // real model plays the player — this description is right about as often
      // as the draw allows. What holds either way is that the verdict and the
      // score agree, and that a wrong guess leaves the round standing.
      if (relayed.result.verdict === "wrong") {
        expect(relayed.result.score).toBe(0);
        expect(relayed.state).toBe("playing");
        expect(lastStateIn(turn.events, Board)).toMatchObject({
          score: 0,
          wrongGuesses: [relayed.result.guess],
        });
      } else {
        expect(relayed.result.verdict).toBe("correct");
        expect(relayed.result.score).toBe(1);
      }
      // Only a SCRIPT can pin the player's exact words. `WRONG_PLAYER` is what
      // makes them predictable, so asserting them against a live model asserts
      // the script rather than the agent — which is how this case used to fail
      // on "Is it a zebra?" being a perfectly good wrong guess.
      if (mode === "stub") {
        expect(relayed.result).toMatchObject({
          verdict: "wrong",
          playerSaid: "Is it a zebra crossing?",
          guess: "zebra crossing",
          score: 0,
        });
      }
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
      // A DESCRIPTION that happens to contain the word, not a question about it.
      // "How would I even describe that?" is the describer asking for help, and
      // a host that answered it in words — or reached for `repeat_word` — was
      // reading the turn correctly while this case failed it for not relaying.
      // The host's relay below is sanitized — the word is not in the script's
      // args — and the tool still rules a foul off what the caller actually said.
      const turn = await session.say(
        `Okay, so ${word} — it's the sort of thing you would find around a house.`,
      );

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
        {
          tool: "relay_description",
          args: { description: "it's the sort of thing you would find around a house" },
        },
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
