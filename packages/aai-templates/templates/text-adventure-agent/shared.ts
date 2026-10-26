import { type SlotValueOf, sessionSlot } from "@alexkroman1/aai";

export type GameState = {
  inventory: string[];
  currentRoom: string;
  score: number;
  /**
   * Committed player turns — a MOVE in the printed games' sense, counted by
   * the `userTranscript.committed` hook in `agent.ts` whether or not the
   * narrator calls a tool. A room change is not a move; saying something is.
   */
  moves: number;
  /** The player's title, derived from `score` by the slot's `after` hook. No tool writes it. */
  rank: string;
  flags: Record<string, boolean>;
};

/**
 * The score ladder, lowest first — the classic adventure's "Your score is 25
 * (Amateur Adventurer)".
 */
const RANKS = [
  [0, "Beginner"],
  [25, "Amateur Adventurer"],
  [50, "Novice Adventurer"],
  [100, "Junior Adventurer"],
  [200, "Adventurer"],
  [300, "Master Adventurer"],
  [400, "Wizard"],
] as const;

/** The rank a score earns. */
export function rankFor(score: number): string {
  let rank: string = RANKS[0][1];
  for (const [at, title] of RANKS) {
    if (score >= at) rank = title;
  }
  return rank;
}

/**
 * A fresh game. The opening room must agree with the greeting in `agent.ts`
 * and the world map in `system-prompt.md`. `rank` is the slot's `after` hook's
 * to fill — it runs on this default too.
 */
export const DEFAULT_GAME_STATE: GameState = {
  inventory: [],
  currentRoom: "Cave Mouth",
  score: 0,
  moves: 0,
  rank: "",
  flags: {},
};

/**
 * How often the hooded scavenger is waiting when the player puts something
 * down. The prompt says he "appears unpredictably"; this is where the
 * unpredictability lives, as a die roll off `ctx.random` in `game_state_drop`,
 * so a spec can state what it drew.
 */
export const SCAVENGER_CHANCE = 0.25;

/** The flag `game_state_drop` sets the first time the scavenger strikes. */
export const SCAVENGER_FLAG = "scavenger_struck";

/**
 * The game, one per session. Its view is the status line every text adventure
 * prints across the top of the screen — the CRT's top bar (`sync: true`) and
 * what `game_state_get` opens with — so the narrator and the player can never
 * disagree about the four numbers.
 */
export const gameSlot = sessionSlot("game", DEFAULT_GAME_STATE, {
  sync: true,
  view: ({ currentRoom, score, rank, moves }) => ({ currentRoom, score, rank, moves }),
  after: (game) => {
    game.rank = rankFor(game.score);
  },
});

/**
 * The board as the NARRATOR is given it, under the prompt on every request
 * (`promptContext` in `agent.ts`) — so where the player is and what they carry
 * is never remembered, guessed, or a turn behind. Prose rather than the JSON
 * `game_state_get` answers with, because this is read as instructions.
 */
export function statusBlock(game: SlotValueOf<typeof gameSlot>): string {
  const { currentRoom, score, rank, moves } = gameSlot.projected(game);
  const carrying = game.inventory.length > 0 ? game.inventory.join(", ") : "nothing";
  return [
    "CURRENT GAME STATE (the game's own record, refreshed before every reply —",
    "it is ground truth and it is never out of date, so answer from it rather",
    "than from memory, and never contradict it):",
    `- Location: ${currentRoom}`,
    `- Score: ${score} (${rank})`,
    `- Turns taken: ${moves}`,
    `- Carrying: ${carrying}`,
  ].join("\n");
}
