/**
 * The game's state, its scoring, and what the scoreboard sees.
 *
 * **Adapted from Pipecat's `word-wrangler-gemini-live` example** (BSD-2-Clause,
 * <https://github.com/pipecat-ai/pipecat-examples>,
 * `word-wrangler-gemini-live/phone-game/bot.py`): a three-way word game over
 * the phone in which an AI HOST hands a human a word, the human describes it
 * without saying it, and a second AI, the PLAYER, tries to guess. It is the
 * largest single-agent example in that repository and the one built for a
 * problem LLMs are bad at — a real-time conversation with three participants
 * — which it solves with a `ParallelPipeline`: two Gemini Live sessions on two
 * branches, a producer/consumer pair feeding the player's speech back into the
 * host's ears, a text filter swallowing the host's "NO" and "IGNORE" replies, a
 * regex over the host's streamed text to detect a new word and a score, and a
 * disconnect-and-reconnect of the player on every new word so it never carries
 * a previous word's context.
 *
 * | word-wrangler phone game | here |
 * | --- | --- |
 * | the host `GeminiLiveLLMService` (text modality) | the voice agent — its model and its TTS |
 * | the player `ResettablePlayerLLM` (its own Gemini Live session) | `askPlayer` in `player.ts`: one `ctx.generate` per description, on the player's own system prompt |
 * | `ParallelPipeline` + `ProducerProcessor`/`ConsumerProcessor` (player audio → host input) | `tools/relay_description.ts`: the host hands the player the description and gets the guess back as a tool result |
 * | the player's disconnect/reconnect on a new word (`NewWordNotifier`) | the player's prompt is built from THIS word's descriptions only — there is no context to reset |
 * | `HostResponseTextFilter` ("NO" / "IGNORE" never reach TTS) | the host is never asked to judge: `isCorrectGuess` (`guess.ts`) is the referee |
 * | `GameStateTracker` (regex over host text for "your next word is" and "that's N points") | {@link GameState}: the score and the word are written by the tools, never parsed back out of speech |
 * | `GameTimer` (`asyncio.sleep(120)` then an `EndFrame`) | `playing`'s `timeout` in `game.ts`: `{ afterMs: 120_000, send: "TIME_UP" }` |
 * | `StartGate` (the player waits for the host's intro) | `relay_description` is gated on `playing`, which `start_game` enters |
 * | "the describer CANNOT say any part of the word" (a prompt rule) | {@link containsWord} over the describer's own transcript — a FOUL, and the word is forfeited |
 * | `word_list.py` / `generate_game_words` | `words.ts` / `pickWords` |
 * | `INTRO_MESSAGE` (the exact opening line) | `start_game`'s `intro`, read verbatim |
 *
 * **Their whole architecture exists to get a second model into the room without
 * the first model hearing itself, and a tool boundary is that room.** The host
 * model calls `relay_description` with what the describer said; the tool runs the
 * player's model on the player's prompt, with only this word's descriptions, and
 * hands back a guess. The host never sees the player's context and the player
 * never hears the host, which is the isolation two pipelines, a resampler and a
 * reconnect were buying. What is LOST is the player's own voice: their game has
 * two voices on the line and this one has the host relaying the guess in its
 * own. That is the honest cost of one TTS stream, stated here rather than hidden.
 *
 * **Scoring moved from the host's mouth to the tools' hands.** Their host was
 * asked to keep score in its head and announce it in a fixed phrase, which a
 * regex then parsed back out of the transcript; a host that said "Correct! Three
 * points" instead of "That's 3 points" lost the score. Here `relay_description`
 * compares the guess to the word and increments a number, and the scoreboard
 * renders the number.
 */

import type { DeepReadonly } from "@alexkroman1/aai";
import { sessionSlot } from "@alexkroman1/aai";
import { containsWord } from "./guess.ts";

/** Their `GAME_DURATION_SECONDS`: the phone game gives two minutes. */
export const GAME_SECONDS = 120;
/** Their `NUM_WORDS_PER_GAME`. */
export const WORDS_PER_GAME = 20;

export type RoundOutcome = "solved" | "skipped" | "fouled";

export interface RoundLog {
  word: string;
  outcome: RoundOutcome;
  /** Wrong guesses the player made before this word was settled. */
  guesses: number;
}

export interface GameState {
  /** This round's words, in the order they will be given. */
  words: string[];
  /** Index of the word in play. */
  index: number;
  score: number;
  skips: number;
  fouls: number;
  /** Epoch ms when `start_game` ran; `null` until the first round. */
  startedAt: number | null;
  /** Epoch ms when `final_score` closed the round. */
  endedAt: number | null;
  /** What the describer has said about the current word, in order. */
  descriptions: string[];
  /** The player's wrong guesses for the current word. */
  wrongGuesses: string[];
  /** Every settled word this round, newest last. */
  rounds: RoundLog[];
  /** The best score across this session's rounds — their web client's `bestScore`. */
  best: number;
  /** The player's most recent remark, for the scoreboard. */
  lastRemark: string | null;
}

export function newGame(): GameState {
  return {
    words: [],
    index: 0,
    score: 0,
    skips: 0,
    fouls: 0,
    startedAt: null,
    endedAt: null,
    descriptions: [],
    wrongGuesses: [],
    rounds: [],
    best: 0,
    lastRemark: null,
  };
}

/** The round, as one typed slot. */
export const gameSlot = sessionSlot("game", newGame);

/** The game as a READ hands it out: deep-frozen, and typed to say so. */
export type FrozenGameState = DeepReadonly<GameState>;

/** The word in play, or `null` between rounds and once the list is spent. */
export function currentWord(game: FrozenGameState): string | null {
  return game.words[game.index] ?? null;
}

/** Whole seconds left on the clock, never negative. `null` before a round starts. */
export function secondsLeft(game: FrozenGameState, now: number = Date.now()): number | null {
  if (game.startedAt === null) return null;
  return Math.max(0, Math.ceil((game.startedAt + GAME_SECONDS * 1000 - now) / 1000));
}

/**
 * Settle the current word and move to the next. Returns the word that was
 * settled, or `null` when nothing was in play.
 */
export function advanceWord(game: GameState, outcome: RoundOutcome): string | null {
  const word = game.words[game.index];
  if (word === undefined) return null;
  game.rounds.push({ word, outcome, guesses: game.wrongGuesses.length });
  game.index += 1;
  game.descriptions = [];
  game.wrongGuesses = [];
  return word;
}

/** Did the describer give the word away? Their host prompt's one hard rule, as a check. */
export function isFoul(description: string, word: string): boolean {
  return containsWord(description, word);
}

// ─── What the scoreboard sees ────────────────────────────────────────────────

export interface GameView {
  phase: "idle" | "playing" | "over";
  /** The word on the describer's screen — the one thing the player must never see. */
  word: string | null;
  score: number;
  skips: number;
  fouls: number;
  best: number;
  startedAt: number | null;
  durationMs: number;
  wordsLeft: number;
  rounds: readonly DeepReadonly<RoundLog>[];
  lastRemark: string | null;
  wrongGuesses: readonly string[];
}

export function gameView(game: FrozenGameState): GameView {
  const phase = game.startedAt === null ? "idle" : game.endedAt === null ? "playing" : "over";
  return {
    phase,
    word: phase === "playing" ? currentWord(game) : null,
    score: game.score,
    skips: game.skips,
    fouls: game.fouls,
    best: game.best,
    startedAt: game.startedAt,
    durationMs: GAME_SECONDS * 1000,
    wordsLeft: Math.max(0, game.words.length - game.index),
    rounds: game.rounds,
    lastRemark: game.lastRemark,
    wrongGuesses: game.wrongGuesses,
  };
}

/** The projection BOTH ends use: `syncState` on the agent, `useAgentState` in the client. */
export const gameProjection = gameSlot.projection(gameView);
