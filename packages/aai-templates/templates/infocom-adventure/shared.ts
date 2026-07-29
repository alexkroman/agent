import type { Kv } from "@alexkroman1/aai";

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

// KV is scoped per deployment, not per session — key the game state by
// session ID so concurrent players each get their own game.
const gameStateKey = (sessionId: string) => `game_state:${sessionId}`;

export async function getGameState(kv: Kv, sessionId: string): Promise<GameState> {
  const saved = await kv.get<GameState>(gameStateKey(sessionId));
  return saved ?? structuredClone(DEFAULT_GAME_STATE);
}

export async function saveGameState(kv: Kv, sessionId: string, state: GameState): Promise<void> {
  await kv.set(gameStateKey(sessionId), state);
}

export async function resetGameState(kv: Kv, sessionId: string): Promise<GameState> {
  const fresh = structuredClone(DEFAULT_GAME_STATE);
  await kv.set(gameStateKey(sessionId), fresh);
  return fresh;
}
