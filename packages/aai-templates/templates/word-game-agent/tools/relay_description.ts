import { withInstruction } from "@alexkroman1/aai";
import { plural } from "@alexkroman1/aai/utils";
import { z } from "zod";
import { gameFlow, type RoundEnd } from "../game.ts";
import { isCorrectGuess } from "../guess.ts";
import { askPlayer, type PlayerGuess } from "../player.ts";
import {
  advanceWord,
  currentWord,
  gameSlot,
  isFoul,
  requireWord,
  score,
  secondsLeft,
} from "../shared.ts";

/**
 * What `prepare` decided about the description, for the window to apply:
 * the clock had run out, the describer gave the word away, or the player
 * guessed. Only the last costs a model call.
 */
type Ruling =
  | { kind: "time_up" }
  | { kind: "foul"; word: string }
  | { kind: "guess"; word: string; heard: string[]; guess: PlayerGuess };

/**
 * Hand the describer's words to the player and referee the guess — their whole
 * `ParallelPipeline` as one tool.
 *
 * Three things happen in here that were three processors there:
 *
 * - **The FOUL check reads the describer's own transcript**, not only what the
 *   host passed — and reads ALL of it. `game.spoken` is every committed
 *   utterance since this word came up, written by the session-event hook rather
 *   than by any tool, so a host that batched three sentences into one relay
 *   cannot hide the one that said the word; `ctx.messages`' last user turn is
 *   the same evidence for a run where nothing committed a transcript. Their
 *   rule was a sentence in the host's prompt; a describer who said the word was
 *   scored a point if the host did not notice.
 * - **The player's model runs with only this word's context** (`askPlayer`),
 *   which is what their disconnect-and-reconnect on every new word was for.
 * - **The referee is `isCorrectGuess`**, so the host never rules on a guess and
 *   never has to say "NO" for a filter to swallow.
 *
 * The clock is checked here too. The dialog's deadline is what ends a round,
 * but a deadline does not survive a process restart, so a description arriving
 * after two minutes on the slot's own clock ends the round anyway.
 *
 * `prepare` rules (and asks the player); `execute` is the synchronous window
 * that scores. `sendFrom: "next"` rather than `send`: almost every call moves
 * nothing (the position stays `playing`, which is what keeps the clock honest),
 * and the two that do — the last word solved, the clock found expired — carry
 * their own event.
 */
export default gameSlot.updateTool({
  description:
    "Relay what the describer just said about their word to the A.I. player and get its guess " +
    "back, refereed. Call it on EVERY turn the describer describes, with their words as close to " +
    "verbatim as possible. The result says whether the guess was right, the score, and the next " +
    "word when there is one.",
  dialog: gameFlow,
  when: "playing",
  sendFrom: "next",
  inputSchema: z.object({
    description: z
      .string()
      .min(1)
      .max(600)
      .describe("What the describer said, verbatim where possible"),
  }),
  require: requireWord,
  prepare: async ({ description }, before, ctx): Promise<Ruling> => {
    const word = currentWord(before) ?? "";
    if ((secondsLeft(before, ctx.now()) ?? 0) <= 0) return { kind: "time_up" };

    // Everything the describer is on record as having said since this word came
    // up — every committed transcript (`GAME_EVENTS` writes them) and the turn
    // the runtime handed this call — beside the host's relay of them. A foul in
    // any of them is a foul.
    const said = [
      description,
      ...before.spoken,
      ctx.messages.findLast((m) => m.role === "user")?.content ?? "",
    ];
    if (said.some((text) => isFoul(text, word))) return { kind: "foul", word };

    // The player hears this word's descriptions and nothing else.
    const heard = [...before.descriptions, description];
    const guess = await askPlayer(ctx.generate, {
      descriptions: heard,
      wrongGuesses: before.wrongGuesses,
    });
    return { kind: "guess", word, heard, guess };
  },
  execute: (_args, game, ruling, ctx) => {
    if (ruling.kind === "time_up") {
      const next: RoundEnd = "TIME_UP";
      return { verdict: "time_up" as const, score: score(game), next };
    }
    const { word } = ruling;
    if (ruling.kind === "foul") {
      game.lastRemark = null;
      advanceWord(game, "fouled");
      const nextWord = currentWord(game);
      const next: RoundEnd = nextWord === null ? "WORDS_DONE" : undefined;
      return withInstruction(
        { verdict: "foul" as const, word, score: score(game), nextWord, next },
        `The describer said the word - "${word}" is forfeited, no point. ` +
          (nextWord === null ? "That was the last word." : `The next word is ${nextWord}.`),
      );
    }

    const { heard, guess } = ruling;
    // The word may have moved while the player thought (a skip landing in the
    // same step); score against the word the description was FOR.
    if (currentWord(game) !== word) {
      // `next: undefined` stays put: `withInstruction` wraps each arm on its
      // own, so the field the gate reads is spelled on every arm.
      return withInstruction(
        { verdict: "stale" as const, score: score(game), next: undefined },
        "That word has already moved on.",
      );
    }
    game.descriptions = heard;
    game.lastRemark = guess.remark;
    if (isCorrectGuess(guess.guess, word)) {
      // The point IS the settled round, so `advanceWord` is what scores it.
      advanceWord(game, "solved");
      const points = score(game);
      const nextWord = currentWord(game);
      const next: RoundEnd = nextWord === null ? "WORDS_DONE" : undefined;
      return withInstruction(
        {
          verdict: "correct" as const,
          playerSaid: guess.remark,
          guess: guess.guess,
          word,
          score: points,
          nextWord,
          secondsLeft: secondsLeft(game, ctx.now()),
          next,
        },
        `Correct! That's ${points} ${plural(points, "point")}. ` +
          (nextWord === null ? "That was the last word!" : `Your next word is ${nextWord}.`),
      );
    }
    game.wrongGuesses.push(guess.guess);
    return withInstruction(
      {
        verdict: "wrong" as const,
        playerSaid: guess.remark,
        guess: guess.guess,
        score: score(game),
        secondsLeft: secondsLeft(game, ctx.now()),
        next: undefined,
      },
      `Relay the player's remark ("${guess.remark}") and let the describer keep going.`,
    );
  },
});
