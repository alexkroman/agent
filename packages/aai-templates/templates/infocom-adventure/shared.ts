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
 * rides in the slot's stored value for the length of the call, so it needs a
 * cap — and only the last few are ever read (`game_state_get` reports five), so
 * the older ones are cost without a reader.
 */
export const MAX_HISTORY = 50;

/** How many of those commands `game_state_get` reports back to the model. */
export const REPORTED_HISTORY = 5;

// The game lives in one `sessionSlot`, keyed per session — each session is its
// own playthrough, so concurrent players never see each other's game and a
// fresh session starts a fresh adventure. The clone is load-bearing:
// `DEFAULT_GAME_STATE` is one module-level object shared by every session in
// the process.
//
// Every tool here is declared through the slot, and WHICH HALF is the decision
// to get right: `gameSlot.tool` hands the body a deep-frozen value and
// `gameSlot.updateTool` hands it a draft that is stored when the body returns.
// `game_state_take` and `game_state_flag` were declared with the reading half
// while pushing to `inventory` and writing to `flags` — a `TypeError` on the
// first call and every call, once `freezeStorable` deep-froze what a read hands
// out. It is a compile error now, which is the reason to declare a tool through
// the slot at all rather than reaching for `gameSlot.get(ctx)` inside a
// `tool()`.
export const gameSlot = sessionSlot("game", () => structuredClone(DEFAULT_GAME_STATE));

/**
 * Log a player command and count the turn, holding {@link MAX_HISTORY}.
 *
 * **Nothing the MODEL can call runs this** — `agent.ts` declares it as a
 * `user-transcript.committed` hook, so it runs once per thing the player says,
 * whether or not the narrator cooperates. It replaced a `game_state_history`
 * TOOL whose `value` argument was the player's own command: the framework
 * already had the transcript, and the tool existed to hand it back. That cost a
 * model call per turn and desynced `moves` and `history` from the game every
 * time the model forgot the system prompt's instruction to call it.
 *
 * Which is also why `moves` is counted HERE and not in `game_state_move`. It
 * used to be both, so a turn where the narrator moved the player AND logged the
 * command counted twice, and a turn where it did neither counted nothing. A
 * MOVE is a room change; a TURN is the player saying something, and only one of
 * those is a thing the game can miscount.
 */
export function recordTurn(game: GameState, command: string): void {
  pushCapped(game.history, command, MAX_HISTORY);
  game.moves++;
}
