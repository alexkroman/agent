import type { ToolContext } from "@alexkroman1/aai";

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

// The game lives in `ctx.state`, the agent's per-session mutable state — each
// session is its own playthrough, so concurrent players never see each
// other's game and a fresh session starts a fresh adventure.
type StateSlot = { game?: GameState };

/** The session's live game. Mutations to the returned object stick — it is
 *  the object stored in `ctx.state`. */
export function getGameState(ctx: ToolContext): GameState {
  const slot = ctx.state as StateSlot;
  slot.game ??= structuredClone(DEFAULT_GAME_STATE);
  return slot.game;
}

export function resetGameState(ctx: ToolContext): GameState {
  const slot = ctx.state as StateSlot;
  slot.game = structuredClone(DEFAULT_GAME_STATE);
  return slot.game;
}
