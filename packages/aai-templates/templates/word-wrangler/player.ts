/**
 * The PLAYER — their second Gemini Live session, as one `ctx.generate` call.
 *
 * Their `ResettablePlayerLLM` disconnected and reconnected on every new word so
 * the player never carried a previous word's context, and a `StartGate` held it
 * silent until the host had finished the introduction. Both are structural
 * here: the prompt is built from THIS word's descriptions and this word's wrong
 * guesses, and nothing else, so there is no context to reset; and the tool that
 * asks it is gated on `playing`, which the host's `start_game` enters.
 *
 * `PLAYER_SYSTEM` is their `game_player_prompt`, adapted for a player whose
 * guess is relayed rather than spoken: it answers a SHAPE (`guess` plus the
 * remark the host will read out), so the referee compares a word and not a
 * sentence. The schema is what `stubGenerate` scripts in the spec, keyed by this
 * system prompt.
 */

import type { GenerateFn } from "@alexkroman1/aai";
import { z } from "zod";

export const PLAYER_SYSTEM = `You are the player in a game of Word Wrangler.

GAME RULES:
1. A human describer has been given a word or short phrase they must describe to you.
2. The describer cannot say any part of the word itself.
3. You guess the word from what they have said so far.
4. The describer is trying to get through as many words as possible before the clock runs out, so guess promptly.

YOUR ROLE:
- Read every description the describer has given for this word, and every guess of yours that was wrong.
- Make one intelligent NEW guess - never repeat a wrong one.
- Give your guess as a single word or short phrase, and a short spoken remark the host will read aloud, in the form "Is it a pen?" - brief, enthusiastic, and no more than one sentence.
- If the descriptions are too thin to guess from, guess your best candidate anyway and make the remark ask for another clue.`;

export const playerGuessSchema = z.object({
  guess: z.string().min(1).describe("The word or phrase you think it is - just the word"),
  remark: z.string().min(1).max(160).describe('What you say out loud, e.g. "Is it a pen?"'),
});

export type PlayerGuess = z.infer<typeof playerGuessSchema>;

export interface PlayerInput {
  /** What the describer has said about this word, in order. */
  descriptions: readonly string[];
  /** This word's wrong guesses, so the player does not repeat one. */
  wrongGuesses: readonly string[];
}

/** The player's prompt for one word: everything it knows, and nothing about any other word. */
export function playerPrompt(input: PlayerInput): string {
  const said = input.descriptions.map((d, i) => `${i + 1}. ${d}`).join("\n");
  const wrong =
    input.wrongGuesses.length === 0
      ? "None yet."
      : input.wrongGuesses.map((g) => `- ${g}`).join("\n");
  return `The describer has said, in order:\n${said}\n\nYour earlier guesses for this word, all WRONG:\n${wrong}\n\nGive one new guess.`;
}

/** Ask the player for its next guess. */
export async function askPlayer(generate: GenerateFn, input: PlayerInput): Promise<PlayerGuess> {
  const { object } = await generate({
    system: PLAYER_SYSTEM,
    prompt: playerPrompt(input),
    schema: playerGuessSchema,
    temperature: 0.7,
  });
  return object;
}
