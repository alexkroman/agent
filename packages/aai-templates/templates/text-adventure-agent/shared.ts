import {
  type DeepReadonly,
  type SlotHolder,
  type StateProjection,
  sessionSlot,
} from "@alexkroman1/aai";

export type GameState = {
  inventory: string[];
  currentRoom: string;
  score: number;
  moves: number;
  /**
   * The player's title, DERIVED from `score` — see {@link rankFor} and the
   * slot's `after` hook. No tool writes this field.
   */
  rank: string;
  flags: Record<string, boolean>;
  history: string[];
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

/**
 * The rank a score earns — the PREDICATE beside the writer.
 *
 * `after` owns the write (below), so no mutating tool can store a stale rank.
 * But `update` runs `mutate(draft)` and only THEN `after(draft)`, so a result
 * object a tool body builds carries the rank the game had BEFORE the score
 * landed — which is exactly the turn a rank changes on, and the only turn the
 * narrator has anything to announce. A body that must report the new rank in
 * the same call reads it from here rather than from `game.rank`;
 * `game_state_score` is the one that does.
 */
export function rankFor(score: number): string {
  let rank: string = RANKS[0][1];
  for (const [at, title] of RANKS) {
    if (score >= at) rank = title;
  }
  return rank;
}

export const DEFAULT_GAME_STATE: GameState = {
  inventory: [],
  currentRoom: "Cave Mouth",
  score: 0,
  moves: 0,
  // `after` runs on `update` and not on `create`/`reset`, so the starting value
  // has to be right here — and stating it through `rankFor` is what stops the
  // fresh game and the first scored point disagreeing about the bottom rung.
  rank: rankFor(0),
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

/**
 * How often the hooded scavenger is waiting when the player puts something
 * down. The prompt has always said he "appears unpredictably" — this is where
 * the unpredictability lives now, as a die roll off `ctx.random` in
 * `game_state_drop` rather than as the model's idea of a coin flip. Same
 * argument as the turn counter in `agent.ts`: it costs no model call, it cannot
 * be forgotten, and a spec can state what it drew.
 */
export const SCAVENGER_CHANCE = 0.25;

/** The flag `game_state_drop` sets the first time the scavenger strikes. */
export const SCAVENGER_FLAG = "scavenger_struck";

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
export const gameSlot = sessionSlot("game", () => structuredClone(DEFAULT_GAME_STATE), {
  caps: { history: MAX_HISTORY },
  // The one derived field, recalculated where the slot is rather than at every
  // call site that can move the score. `game_state_score` is the only writer
  // today; the hook is what makes a SECOND one — a treasure bonus, a penalty
  // for dying in the dark — unable to ship a stale rank.
  after: (game) => {
    game.rank = rankFor(game.score);
  },
});

/**
 * The game as a READ hands it out: deep-frozen, and typed to say so.
 *
 * Every pure helper below takes this rather than {@link GameState}. A mutable
 * `GameState` still satisfies it, so a helper called with an `updateTool` draft
 * is unaffected, while a helper that WOULD have mutated stops compiling instead
 * of throwing on its first call in production.
 */
export type FrozenGameState = DeepReadonly<GameState>;

/** The status line every text adventure prints: where you are, and how you are doing. */
export type StatusLine = {
  currentRoom: string;
  score: number;
  rank: string;
  moves: number;
};

/**
 * The four facts the status line carries, read the same way by both readers:
 * `game_state_get` (the narrator) and `syncState` (the CRT's top bar).
 */
export function statusLine(game: FrozenGameState): StatusLine {
  return {
    currentRoom: game.currentRoom,
    score: game.score,
    rank: game.rank,
    moves: game.moves,
  };
}

/**
 * The board as the NARRATOR is given it, before every reply.
 *
 * `agent.ts` appends this to the system prompt through a `systemPrompt`
 * resolver, so the four facts of the status line plus the inventory are in
 * front of the model on every request — never remembered, never guessed, and
 * never a turn behind.
 *
 * **This is what retired a whole section of `system-prompt.md`.** The prompt
 * used to spend six lines insisting that ANY question about what the player is
 * carrying, where they are or what they have scored be answered by calling
 * `game_state_get` FIRST and never from memory — advice, enforced by nothing,
 * costing a model round trip on the turns the narrator remembered and a drifting
 * world on the turns it did not. State the model must not invent belongs in the
 * prompt, not in a rule telling it to go and look.
 *
 * Prose rather than the JSON `game_state_get` answers with, because this is
 * read as instructions rather than as a tool result — and built from
 * {@link statusLine}, so the narrator, the CRT's top bar and the read tool
 * cannot disagree about the four numbers. `game_state_get` stays for the rest of
 * the board (the flags and the recent commands) and for the turn the narrator
 * wants everything at once.
 */
export function statusBlock(game: FrozenGameState): string {
  const { currentRoom, score, rank, moves } = statusLine(game);
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

/**
 * The projection BOTH ends use: `syncState` on the agent, `useAgentState` in
 * the client.
 *
 * Annotated, unlike the pure helpers above, because this is the template's one
 * export that crosses the server/browser boundary — the payload the runtime
 * serializes and pushes on every state change. Naming {@link StatusLine} here
 * puts the wire contract in the module's signature instead of leaving it to be
 * chased through `projection`'s inference.
 */
export const gameStatus: StateProjection<StatusLine> = gameSlot.projection(statusLine);

/**
 * Log a player command and count the turn. The slot holds {@link MAX_HISTORY}.
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
 *
 * `SlotHolder` rather than `ToolContext` is the whole seam: `{ slots,
 * sessionId }` is all any slot accessor reads, so this one helper is callable
 * from a tool body and from a session event handler alike — and the handler's
 * `SessionEventContext` carries no `send` and no `generate`, which is the line
 * an event hook cannot cross.
 */
export function recordTurn(ctx: SlotHolder, command: string): void {
  gameSlot.update(ctx, (game) => {
    game.history.push(command);
    game.moves++;
  });
}
