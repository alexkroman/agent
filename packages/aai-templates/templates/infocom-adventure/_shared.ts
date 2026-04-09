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

export async function getGameState(kv: {
  get: <T>(key: string) => Promise<T | null>;
}): Promise<GameState> {
  const saved = await kv.get<GameState>("game_state");
  return saved ?? { ...DEFAULT_GAME_STATE };
}

export async function saveGameState(
  kv: { set: (key: string, value: unknown) => Promise<void> },
  state: GameState,
): Promise<void> {
  await kv.set("game_state", state);
}
