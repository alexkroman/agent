import { pushCapped, sessionSlot } from "@alexkroman1/aai";

export type GameState = {
  inventory: string[];
  currentRoom: string;
  score: number;
  moves: number;
  flags: Record<string, boolean>;
  history: string[];
};

export const DEFAULT_GAME_STATE: GameState = {
  inventory: [],
  currentRoom: "Cave Mouth",
  score: 0,
  moves: 0,
  flags: {},
  history: [],
};

/**
 * How many player commands the game remembers. The history is append-only and
 * lives in `ctx.state` for the length of the call, so it needs a cap — and
 * only the last few are ever read (`game_state_get` reports five), so the
 * older ones are cost without a reader.
 */
export const MAX_HISTORY = 50;

/**
 * How many of those commands a tool reports back to the model.
 *
 * Named because two tools answer with it (`game_state_get` and
 * `game_state_history`), and they live in separate files now — an inline `-5`
 * in each is a number that can disagree with itself.
 */
export const REPORTED_HISTORY = 5;

// The game lives in `ctx.state`, the agent's per-session mutable state — each
// session is its own playthrough, so concurrent players never see each
// other's game and a fresh session starts a fresh adventure. The clone is
// load-bearing: `DEFAULT_GAME_STATE` is one module-level object shared by
// every session in the process.
export const gameSlot = sessionSlot("game", () => structuredClone(DEFAULT_GAME_STATE));

/** Log a player command, holding {@link MAX_HISTORY}. */
export function recordCommand(game: GameState, command: string): void {
  pushCapped(game.history, command, MAX_HISTORY);
}
