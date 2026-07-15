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
  currentRoom: "West of House",
  score: 0,
  moves: 0,
  flags: {},
  history: [],
};

export async function getGameState(kv: Kv): Promise<GameState> {
  const saved = await kv.get<GameState>("game_state");
  return saved ?? { ...DEFAULT_GAME_STATE };
}

export async function saveGameState(kv: Kv, state: GameState): Promise<void> {
  await kv.set("game_state", state);
}
