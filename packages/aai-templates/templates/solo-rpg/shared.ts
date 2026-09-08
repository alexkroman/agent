import {
  type DeepReadonly,
  dialog,
  pickOne,
  type RandomSource,
  randomInt,
  sessionSlot,
  shuffled,
} from "@alexkroman1/aai";

// ── Tuning Constants ─────────────────────────────────────────────────────────
export const MOMENTUM_RESET = 2;
export const MAX_RESOURCE = 5;
export const MIN_MOMENTUM = -6;
export const MAX_BOND = 4;
export const MAX_NPCS = 12;
export const MAX_CLOCKS = 8;
export const MIN_CLOCK_SEGMENTS = 2;
export const MAX_CLOCK_SEGMENTS = 12;
export const DEFAULT_CLOCK_SEGMENTS = 6;

// ── Creativity Seeds ─────────────────────────────────────────────────────────
const SEED_WORDS = [
  "amber",
  "coyote",
  "furnace",
  "silk",
  "glacier",
  "compass",
  "terracotta",
  "jasmine",
  "anvil",
  "cobalt",
  "driftwood",
  "saffron",
  "limestone",
  "falcon",
  "obsidian",
  "cedar",
  "mercury",
  "lantern",
  "basalt",
  "thistle",
  "copper",
  "monsoon",
  "flint",
  "orchid",
  "pewter",
  "canyon",
  "quartz",
  "ember",
  "mahogany",
  "coral",
];

/**
 * Unbiased Fisher-Yates shuffle. Returns a new array.
 *
 * `shuffled`'s, which is where the unbiasedness argument now lives. What every
 * randomizing helper in this file gained is the `random` parameter: a tool
 * passes `ctx.random`, so a spec can state the dice a scene was resolved on
 * instead of asserting that the result was one of three strings.
 */
export const shuffle = shuffled;

export function creativitySeed(n = 3, random?: RandomSource): string {
  return shuffle(SEED_WORDS, random).slice(0, n).join(" ");
}

// ── Genres, Tones, Archetypes ────────────────────────────────────────────────
export const GENRES = {
  dark_fantasy: "Dark Fantasy",
  high_fantasy: "High Fantasy",
  science_fiction: "Sci-Fi",
  horror_mystery: "Horror / Mystery",
  steampunk: "Steampunk",
  cyberpunk: "Cyberpunk",
  urban_fantasy: "Urban Fantasy",
  victorian_crime: "Victorian Crime",
  historical_roman: "Historical / Roman",
  fairy_tale: "Fairy Tale World",
  slice_of_life_90s: "Slice of Life 1990s",
  outdoor_survival: "Outdoor Survival",
} as const;

export const TONES = {
  dark_gritty: "Dark & Gritty",
  serious_balanced: "Serious but Fair",
  melancholic: "Melancholic",
  absurd_grotesque: "Absurd & Grotesque",
  slow_burn_horror: "Slow-Burn Horror",
  cheerful_funny: "Cheerful & Fun",
  romantic: "Romantic",
  slapstick: "Slapstick",
  epic_heroic: "Epic & Heroic",
  tarantino: "Tarantino-Style",
  cozy: "Cozy & Comfy",
  tragicomic: "Tragicomic",
} as const;

export const ARCHETYPES = {
  outsider_loner: "Outsider / Loner",
  investigator: "Investigator / Curious",
  trickster: "Trickster / Charmer",
  protector: "Protector / Warrior",
  hardboiled: "Hardboiled / Veteran",
  scholar: "Scholar / Mystic",
  healer: "Healer / Medic",
  inventor: "Crafter / Inventor",
  artist: "Artist / Bard",
} as const;

// ── Moves ────────────────────────────────────────────────────────────────────
// Pure conversation ("dialog") is deliberately NOT a rollable move — it has no
// risk, so the model narrates it without calling action_roll.
export const MOVES = [
  "face_danger",
  "compel",
  "gather_information",
  "secure_advantage",
  "clash",
  "strike",
  "endure_harm",
  "endure_stress",
  "make_connection",
  "test_bond",
  "resupply",
  "world_shaping",
] as const;

export const COMBAT_MOVES = new Set(["clash", "strike"]);
export const SOCIAL_MOVES = new Set(["compel", "make_connection", "test_bond"]);

/** Title-case an id like "face_danger" into "Face Danger". */
function labelFromId(id: string): string {
  return id
    .split("_")
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
}

// Derived from MOVES so adding a move never means updating a second list.
export const MOVE_LABELS: Record<(typeof MOVES)[number], string> = Object.fromEntries(
  MOVES.map((m) => [m, labelFromId(m)]),
) as Record<(typeof MOVES)[number], string>;

// ── Time Phases ──────────────────────────────────────────────────────────────
export const TIME_PHASES = [
  "early_morning",
  "morning",
  "midday",
  "afternoon",
  "evening",
  "late_evening",
  "night",
  "deep_night",
] as const;

// ── Chaos Interrupt Types ────────────────────────────────────────────────────
const CHAOS_INTERRUPT_TYPES = [
  "An NPC arrives unexpectedly",
  "An environmental hazard erupts",
  "A hidden truth is revealed",
  "A complication arises from a past action",
  "A new threat appears on the horizon",
  "An ally changes sides or reveals a secret",
  "Strange phenomena disrupt the scene",
  "A resource is lost or compromised",
];

// ── Dispositions ─────────────────────────────────────────────────────────────
export const DISPOSITIONS = ["hostile", "distrustful", "neutral", "friendly", "loyal"] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

// ── NPC Interface ────────────────────────────────────────────────────────────
export interface NPC {
  id: string;
  name: string;
  description: string;
  disposition: Disposition;
  bond: number;
  agenda: string;
  status: "active" | "background" | "deceased";
}

// ── Clock Interface ──────────────────────────────────────────────────────────
export interface Clock {
  id: string;
  name: string;
  clockType: "threat" | "progress" | "scheme";
  segments: number;
  filled: number;
  triggerDescription: string;
}

// ── Story Blueprint ──────────────────────────────────────────────────────────
export interface StoryAct {
  phase: string;
  title: string;
  goal: string;
  mood: string;
  transitionTrigger: string;
}

export interface StoryBlueprint {
  structureType: "3act" | "kishotenketsu";
  centralConflict: string;
  antagonistForce: string;
  thematicThread: string;
  acts: StoryAct[];
  currentAct: number;
  storyComplete: boolean;
}

// ── Session Log Entry ────────────────────────────────────────────────────────
export interface SessionLogEntry {
  scene: number;
  summary: string;
  location: string;
}

// ── Last Roll (for momentum burn) ────────────────────────────────────────────
/** Exact state changes a roll applied, recorded so a burn can revert them. */
export interface ConsequenceDeltas {
  health: number;
  spirit: number;
  supply: number;
  momentum: number;
  npcId: string | null;
  bond: number;
  dispositionFrom: Disposition | null;
  dispositionTo: Disposition | null;
  clockId: string | null;
  clockTicks: number;
}

export interface LastRoll {
  d1: number;
  d2: number;
  c1: number;
  c2: number;
  statName: string;
  statValue: number;
  actionScore: number;
  result: "STRONG_HIT" | "WEAK_HIT" | "MISS";
  move: string;
  match: boolean;
  position: string;
  effect: string;
  targetNpcId: string | null;
  deltas: ConsequenceDeltas;
}

// ── Game State ───────────────────────────────────────────────────────────────
export interface GameState {
  /**
   * Whether a character exists. The CLIENT's render flag — `client.tsx` shows
   * the character sheet on it — and nothing else.
   *
   * It used to sit beside `phase: "genre" | "playing"`, which was the same bit
   * spelled twice: `phase === "playing"` was true exactly when this was, and
   * neither field gated anything. `phase` is gone and {@link storyFlow} holds
   * the position now — see its own doc for the split.
   */
  initialized: boolean;
  settingGenre: string;
  settingTone: string;
  settingArchetype: string;
  settingDescription: string;
  playerName: string;
  characterConcept: string;
  backstory: string;
  playerWishes: string;
  contentLines: string;
  edge: number;
  heart: number;
  iron: number;
  shadow: number;
  wits: number;
  health: number;
  spirit: number;
  supply: number;
  momentum: number;
  maxMomentum: number;
  sceneCount: number;
  currentLocation: string;
  currentSceneContext: string;
  timeOfDay: string;
  chaosFactor: number;
  crisisMode: boolean;
  gameOver: boolean;
  npcs: NPC[];
  clocks: Clock[];
  storyBlueprint: StoryBlueprint | null;
  sessionLog: SessionLogEntry[];
  lastRoll: LastRoll | null;
  kidMode: boolean;
}

export const DEFAULT_STATE: GameState = {
  initialized: false,
  settingGenre: "",
  settingTone: "",
  settingArchetype: "",
  settingDescription: "",
  playerName: "",
  characterConcept: "",
  backstory: "",
  playerWishes: "",
  contentLines: "",
  edge: 1,
  heart: 2,
  iron: 1,
  shadow: 1,
  wits: 2,
  health: 5,
  spirit: 5,
  supply: 5,
  momentum: MOMENTUM_RESET,
  maxMomentum: 10,
  sceneCount: 0,
  currentLocation: "",
  currentSceneContext: "",
  timeOfDay: "",
  chaosFactor: 5,
  crisisMode: false,
  gameOver: false,
  npcs: [],
  clocks: [],
  storyBlueprint: null,
  sessionLog: [],
  lastRoll: null,
  kidMode: false,
};

// ── Live game state (one session slot) ───────────────────────────────────────
// The in-play game lives in one `sessionSlot`, keyed per session — concurrent
// players get independent games by construction. The clone is load-bearing:
// `DEFAULT_STATE` is one module-level object shared by every session in the
// process, so a factory without it would let one player's game show up in
// another's.
export const gameSlot = sessionSlot("game", () => structuredClone(DEFAULT_STATE), {
  // The derived-field recalculation every mutating tool used to have to
  // remember. It was written out by hand in `applyConsequences`,
  // `revertConsequences` and `update_state`, which is the shape `after` exists
  // to replace: a new tool that empties a track now cannot store a stale
  // `gameOver`, and `gameOver` is what the story flow's `DOWNED` transition
  // reads. `dispatch-center`'s board is the same pattern one template over.
  after: updateCrisisFlags,
  // The session log rides in every `syncState` frame and the client renders
  // its tail; the slot holds the bound so `update_state` need not.
  caps: { sessionLog: 50 },
});

/**
 * The story arc as the CLIENT needs it: how far along, which phase, and whether
 * the story has finished.
 *
 * NOT the acts. Each `StoryAct` carries a `goal`, a `mood` and a
 * `transitionTrigger` — the twists the player has not reached — and the sidebar
 * renders none of them.
 */
export interface StoryArcView {
  currentAct: number;
  totalActs: number;
  phase: string;
  storyComplete: boolean;
}

/**
 * What the browser is sent, which is NOT the whole campaign.
 *
 * This was `gameSlot.projection((game) => game)`, argued as "this campaign IS
 * what the client renders, so there is nothing to trim". It isn't: the sidebar
 * reads 26 of ~35 fields and touches none of the seven dropped here, and of the
 * blueprint it uses only the act COUNT and the current act's phase — so every
 * unplayed act's goal and mood rode in every `syncState` frame. The projection
 * seam is the only defence there is, since slot state is otherwise server-side,
 * and a spoiler leak is invisible in the UI and permanent once someone opens
 * devtools.
 */
export function gameView(game: FrozenGameState) {
  const {
    settingTone,
    settingArchetype,
    settingDescription,
    backstory,
    playerWishes,
    contentLines,
    lastRoll,
    storyBlueprint,
    ...shown
  } = game;
  return {
    ...shown,
    storyArc: storyBlueprint
      ? {
          currentAct: storyBlueprint.currentAct,
          totalActs: storyBlueprint.acts.length,
          phase: storyBlueprint.acts[storyBlueprint.currentAct - 1]?.phase ?? "",
          storyComplete: storyBlueprint.storyComplete,
        }
      : null,
  };
}

/** The projection BOTH ends use: `syncState` on the agent, `useAgentState` in the client. */
export const gameProjection = gameSlot.projection(gameView);

// ── The story, as a machine ──────────────────────────────────────────────────

/**
 * Where the story is, and what may be done from there, as a plain state map.
 *
 * A {@link DialogSpec} rather than an XState machine. This dialog used four
 * events and one instruction per state, which is all a spec can say — and the
 * `setup({ types: {} as { events: … } })` block it used to carry restated the
 * four names already written in the `on` maps. `type: "final"` is `final: true`,
 * and the instruction is a DECLARED field rather than an untyped `meta` bag, so
 * misspelling it is a compile error instead of a refusal that arrives with no
 * recovery text. `as const` keeps the `on` keys literal, so every `send` and
 * `sendFrom` below is checked against the events this spec declares.
 *
 * Three hand-rolled versions of this question lived in the template, and all
 * three were positional questions answered from data:
 *
 * - **`phase: "genre" | "playing"`** (with `initialized` beside it saying the
 *   same thing) gated NOTHING. `action_roll`, `update_state` and
 *   `burn_momentum` all ran happily before a character existed — rolling 2d6
 *   against the stats of nobody, against clocks that were not there.
 * - **`burn_momentum`'s `if (!last) return { error: "No recent action roll to
 *   upgrade. Roll first." }`** is `when` written out by hand. Burning is legal
 *   for exactly as long as a roll is standing, which is a position.
 * - **`gameOver`** was set by `updateCrisisFlags` and read by nobody who could
 *   act on it, so a player whose health and spirit were both gone could keep
 *   rolling for as long as they liked.
 *
 * **What stays in {@link GameState} is what the CLIENT renders** —
 * `initialized`, `crisisMode`, `gameOver` — because `syncState` carries one
 * projection and it is the campaign's. The flow holds the POSITION and the slot
 * holds the campaign, which is the same split `travel-concierge` makes between
 * its gate and its trip: one tool call moves both, in one synchronous window
 * each.
 *
 * **Starting over is a RESET, not a transition.** `setup_character` replaces the
 * campaign with a pristine `DEFAULT_STATE`, so the honest mirror on this side is
 * `storyFlow.reset` — and it is what lets `gameOver` be a genuinely `final`
 * state, which is the whole point of having one: `position().done` means the
 * story ended, and XState delivers no events to a done actor, so an `on: {
 * SETUP }` there would have been dead config that looked live. A resumed run
 * resets for the same reason. `SETUP` therefore appears once, on the only state
 * that can be transitioned out of.
 */
const storySpec = {
  initial: "awaitingSetup",
  states: {
    awaitingSetup: {
      instruction:
        "There is no character yet. Take whatever the player gave you — a name, a " +
        "genre, an idea, or nothing — infer the rest yourself, and call " +
        "setup_character with every field filled in. Ask no follow-up questions.",
      on: { SETUP: "playing" },
    },
    playing: {
      initial: "awaitingRoll",
      on: { DOWNED: "gameOver" },
      states: {
        awaitingRoll: {
          instruction:
            "Narrate the scene and offer two or three choices. Any risky action goes " +
            "through action_roll — never narrate a success or a failure yourself.",
          on: { ROLLED: "rollResolved" },
        },
        rollResolved: {
          instruction:
            "A roll is standing. burn_momentum can still upgrade it if the player " +
            "spends momentum; anything that moves the scene on settles it.",
          // A second roll replaces the standing one, so `ROLLED` re-enters.
          on: { ROLLED: "rollResolved", SETTLED: "awaitingRoll" },
        },
      },
    },
    gameOver: {
      final: true,
      instruction:
        "Health and spirit are both gone. Narrate the ending and stop — nothing " +
        "else may be rolled. setup_character begins a new story.",
    },
  },
} as const;

/**
 * The flow. Its own slot key beside {@link gameSlot}, and the reason it is not
 * folded into the campaign is that the campaign is what the browser renders: a
 * flow stores an XState snapshot, which is not a character sheet.
 */
export const storyFlow = dialog("story", storySpec);

/**
 * The game as a READ hands it out: deep-frozen, and typed to say so.
 *
 * Every pure helper below takes this rather than {@link GameState}, which is
 * the widening a deep-readonly slot forces and the reason it is worth doing:
 * a mutable `GameState` still satisfies it, so a helper called with an
 * `updateTool` draft is unaffected, while a helper that WOULD have mutated
 * stops compiling instead of throwing at its first call in production.
 */
export type FrozenGameState = DeepReadonly<GameState>;

// ── No cross-session saves, and why ─────────────────────────────────────────
// `save_game` / `load_game` stood here, keyed by slot name and backed by an
// `app_state` table through `ctx.db`. Both are gone with `ctx.db` itself: the
// platform provides tool code no database, and a template cannot reach one — the
// scaffold ships no Postgres client, and shipped template code cannot import
// `@alexkroman1/aai-runtime` (templates type-check under the scaffold tsconfig,
// which that package's source is not clean under).
//
// So this adventure is SINGLE-SESSION: everything lives in `sessionSlot`s and
// ends when the call does. An author who wants saves adds a client of their own
// (`postgres`, `pg`, a provider SDK) and a `DATABASE_URL` secret — which is the
// supported pattern, just not one a shipped template can demonstrate.

// ── Helpers ──────────────────────────────────────────────────────────────────
/** One die of `sides`, 1-based. */
export function d(sides: number, random?: RandomSource): number {
  return randomInt(sides, random) + 1;
}

/**
 * One item of a NON-EMPTY list.
 *
 * `pickOne` answers `T | undefined` because a list can be empty; every list
 * this game picks from is a module-level constant that is not, so the assertion
 * is made once here rather than at ten call sites.
 */
export function pick<T>(arr: readonly T[], random?: RandomSource): T {
  return pickOne(arr, random) as T;
}

/**
 * Next sequential id for `prefix` — a max-scan, so removing an item never
 * causes a later id collision (unlike a length+1 counter).
 */
export function nextSeqId(items: readonly { id: string }[], prefix: string): string {
  let max = 0;
  const re = new RegExp(`^${prefix}_(\\d+)$`);
  for (const item of items) {
    const m = item.id.match(re);
    if (m) max = Math.max(max, Number.parseInt(m[1]!, 10));
  }
  return `${prefix}_${max + 1}`;
}

export function makeNpc(opts: {
  id: string;
  name: string;
  description?: string | undefined;
  disposition?: Disposition | undefined;
  agenda?: string | undefined;
}): NPC {
  const disposition = opts.disposition ?? "neutral";
  return {
    id: opts.id,
    name: opts.name,
    description: opts.description ?? "",
    disposition,
    bond: disposition === "friendly" ? 1 : disposition === "loyal" ? 2 : 0,
    agenda: opts.agenda ?? "",
    status: "active",
  };
}

export function clockSummary(c: DeepReadonly<Clock>) {
  return {
    id: c.id,
    name: c.name,
    clockType: c.clockType,
    segments: c.segments,
    filled: c.filled,
    full: c.filled >= c.segments,
    triggerDescription: c.triggerDescription,
  };
}

/**
 * Single source of truth for the state snapshot returned to the LLM by
 * setup_character, update_state, and check_state. Includes the player's
 * content boundaries (contentLines) so they survive past the setup turn.
 */
export function stateSummary(state: FrozenGameState) {
  // The scalars go through UNCHANGED, so they are spread rather than re-listed:
  // what the names pulled out below do to them is the whole content of this
  // function, and it was buried in twenty-six lines of `x: state.x`. A field
  // added to `GameState` now reaches the model without a second edit here.
  //
  // `lastRoll` is destructured to WITHHOLD it — the dice are narrated by the
  // tool that rolled them, not inspected; `crisisMode` and `gameOver` are
  // pulled out because the stored flags are stale here and recomputed below.
  const { npcs, clocks, storyBlueprint, sessionLog, lastRoll, crisisMode, gameOver, ...scalars } =
    state;
  return {
    ...scalars,
    // DERIVED here rather than copied off the state: `after` restores the
    // stored flags only once the calling body has returned, so a summary built
    // inside that body would report the tracks it just emptied as survivable.
    crisisMode: inCrisis(state),
    gameOver: isGameOver(state),
    // NPCs go to the LLM whole (nothing withheld) — copied so a mutation of
    // the summary can't reach live state.
    npcs: npcs.filter((n) => n.status !== "deceased").map((n) => ({ ...n })),
    clocks: clocks.map(clockSummary),
    storyBlueprint: storyBlueprint
      ? {
          structureType: storyBlueprint.structureType,
          currentAct: storyBlueprint.currentAct,
          totalActs: storyBlueprint.acts.length,
          centralConflict: storyBlueprint.centralConflict,
          thematicThread: storyBlueprint.thematicThread,
          storyComplete: storyBlueprint.storyComplete,
          currentPhase: storyBlueprint.acts[storyBlueprint.currentAct - 1]?.phase,
        }
      : null,
    recentLog: sessionLog.slice(-5),
  };
}

// ── Dice System ──────────────────────────────────────────────────────────────
export type RollOutcome = "STRONG_HIT" | "WEAK_HIT" | "MISS";

/**
 * The game's central rule: a score beats both challenge dice, one of them, or
 * neither. Written ONCE — burning momentum is "re-resolve with momentum as the
 * score", so both callers ask the same function rather than each spelling the
 * ladder out.
 */
export function resolveRoll(score: number, c1: number, c2: number): RollOutcome {
  if (score > c1 && score > c2) return "STRONG_HIT";
  if (score > c1 || score > c2) return "WEAK_HIT";
  return "MISS";
}

/** How good an outcome is, for comparing two of them. */
const OUTCOME_RANK: Record<RollOutcome, number> = { MISS: 0, WEAK_HIT: 1, STRONG_HIT: 2 };

export function rollAction(
  statName: string,
  statValue: number,
  move: string,
  random?: RandomSource,
) {
  const d1 = d(6, random),
    d2 = d(6, random);
  const c1 = d(10, random),
    c2 = d(10, random);
  const actionScore = Math.min(d1 + d2 + statValue, 10);
  const result = resolveRoll(actionScore, c1, c2);
  const match = c1 === c2;
  return { d1, d2, c1, c2, statName, statValue, actionScore, result, move, match };
}

export type RollResult = ReturnType<typeof rollAction>;

// ── Chaos Factor ─────────────────────────────────────────────────────────────
export function updateChaosFactor(game: GameState, result: string) {
  if (result === "MISS") game.chaosFactor = Math.min(9, game.chaosFactor + 1);
  else if (result === "STRONG_HIT") game.chaosFactor = Math.max(3, game.chaosFactor - 1);
}

export function checkChaosInterrupt(game: GameState, random?: RandomSource): string | null {
  const threshold = game.chaosFactor - 3;
  if (threshold <= 0) return null;
  const roll = d(10, random);
  if (roll <= threshold) {
    game.chaosFactor = Math.max(3, game.chaosFactor - 1);
    return pick(CHAOS_INTERRUPT_TYPES, random);
  }
  return null;
}

// ── Consequences ─────────────────────────────────────────────────────────────
function emptyDeltas(): ConsequenceDeltas {
  return {
    health: 0,
    spirit: 0,
    supply: 0,
    momentum: 0,
    npcId: null,
    bond: 0,
    dispositionFrom: null,
    dispositionTo: null,
    clockId: null,
    clockTicks: 0,
  };
}

function loseResource(
  game: GameState,
  resource: "health" | "spirit" | "supply",
  dmg: number,
  consequences: string[],
  deltas: ConsequenceDeltas,
): void {
  const old = game[resource];
  game[resource] = Math.max(0, game[resource] - dmg);
  deltas[resource] += game[resource] - old;
  if (game[resource] < old) consequences.push(`${resource} -${old - game[resource]}`);
}

function changeMomentum(game: GameState, amount: number, deltas: ConsequenceDeltas): void {
  const old = game.momentum;
  game.momentum = Math.max(MIN_MOMENTUM, Math.min(game.maxMomentum, game.momentum + amount));
  deltas.momentum += game.momentum - old;
}

/**
 * The one rule that ends a story: both tracks empty.
 *
 * A PREDICATE beside the writer, because the same fact is wanted at two
 * different moments. {@link gameSlot}'s `after` writes
 * {@link GameState.gameOver} from it, which is what keeps the stored flag right
 * for every mutating tool — including one that never thinks about it. A tool
 * that REPORTS the flag in its own result reads the predicate directly, because
 * `after` runs only once the body has already built that result: a copy taken
 * from `state.gameOver` would be one mutation behind, and that copy is exactly
 * what `sendFrom` turns into the `DOWNED` transition.
 */
export function isGameOver(game: FrozenGameState): boolean {
  return game.health <= 0 && game.spirit <= 0;
}

/** Either track empty — what the client paints red. */
export function inCrisis(game: FrozenGameState): boolean {
  return game.health <= 0 || game.spirit <= 0;
}

/**
 * Restore the two derived flags from the tracks they are derived FROM.
 *
 * Called by nothing but {@link gameSlot}'s `after` — it used to be called by
 * hand from three places, which is a rule every future mutating tool has to
 * remember and one of them eventually will not. A stale `gameOver` is not a
 * cosmetic miss: it is what the `DOWNED` transition reads.
 */
function updateCrisisFlags(game: GameState): void {
  game.gameOver = isGameOver(game);
  game.crisisMode = inCrisis(game);
}

export function applyConsequences(
  game: GameState,
  roll: Pick<RollResult, "result" | "move">,
  position: string,
  effect: string,
  targetNpcId: string | null,
): {
  consequences: string[];
  clockEvents: { clock: string; trigger: string }[];
  deltas: ConsequenceDeltas;
} {
  const consequences: string[] = [];
  const clockEvents: { clock: string; trigger: string }[] = [];
  const deltas = emptyDeltas();
  const target = targetNpcId ? game.npcs.find((n) => n.id === targetNpcId) : null;

  if (roll.result === "MISS") {
    if (roll.move === "endure_harm") {
      loseResource(game, "health", position === "desperate" ? 2 : 1, consequences, deltas);
    } else if (roll.move === "endure_stress") {
      loseResource(game, "spirit", position === "desperate" ? 2 : 1, consequences, deltas);
    } else if (COMBAT_MOVES.has(roll.move)) {
      const dmg = position === "desperate" ? 3 : position === "controlled" ? 1 : 2;
      loseResource(game, "health", dmg, consequences, deltas);
    } else if (SOCIAL_MOVES.has(roll.move)) {
      if (target) {
        const oldBond = target.bond;
        target.bond = Math.max(0, target.bond - 1);
        deltas.npcId = target.id;
        deltas.bond = target.bond - oldBond;
        if (target.bond < oldBond) consequences.push(`${target.name} bond -1`);
      }
      loseResource(game, "spirit", position === "desperate" ? 2 : 1, consequences, deltas);
    } else {
      loseResource(game, "supply", 1, consequences, deltas);
      if (position === "desperate") {
        loseResource(game, "health", 2, consequences, deltas);
      } else if (position !== "controlled") {
        loseResource(game, "health", 1, consequences, deltas);
      }
    }

    const momLoss = position === "desperate" ? 3 : 2;
    changeMomentum(game, -momLoss, deltas);
    consequences.push(`momentum -${momLoss}`);

    for (const clock of game.clocks) {
      if (clock.clockType === "threat" && clock.filled < clock.segments) {
        const ticks = position === "desperate" ? 2 : 1;
        const oldFilled = clock.filled;
        clock.filled = Math.min(clock.segments, clock.filled + ticks);
        deltas.clockId = clock.id;
        deltas.clockTicks = clock.filled - oldFilled;
        if (clock.filled >= clock.segments) {
          clockEvents.push({ clock: clock.name, trigger: clock.triggerDescription });
        }
        break;
      }
    }
  } else if (roll.result === "WEAK_HIT") {
    changeMomentum(game, 1, deltas);
    if (roll.move === "make_connection" && target) {
      const oldBond = target.bond;
      target.bond = Math.min(MAX_BOND, target.bond + 1);
      deltas.npcId = target.id;
      deltas.bond = target.bond - oldBond;
    }
  } else {
    const momGain = effect === "great" ? 3 : 2;
    changeMomentum(game, momGain, deltas);
    if ((roll.move === "make_connection" || roll.move === "compel") && target) {
      const oldBond = target.bond;
      target.bond = Math.min(MAX_BOND, target.bond + 1);
      deltas.npcId = target.id;
      deltas.bond = target.bond - oldBond;
      const shifts: Record<string, Disposition> = {
        hostile: "distrustful",
        distrustful: "neutral",
        neutral: "friendly",
        friendly: "loyal",
      };
      const nextDisposition = shifts[target.disposition];
      if (nextDisposition) {
        deltas.dispositionFrom = target.disposition;
        deltas.dispositionTo = nextDisposition;
        target.disposition = nextDisposition;
      }
    }
  }

  return { consequences, clockEvents, deltas };
}

/**
 * Exactly undo the state changes a roll applied (recorded in its deltas).
 * Used by burn_momentum before re-applying the upgraded result.
 */
export function revertConsequences(game: GameState, deltas: ConsequenceDeltas): void {
  game.health = Math.max(0, Math.min(MAX_RESOURCE, game.health - deltas.health));
  game.spirit = Math.max(0, Math.min(MAX_RESOURCE, game.spirit - deltas.spirit));
  game.supply = Math.max(0, Math.min(MAX_RESOURCE, game.supply - deltas.supply));
  game.momentum = Math.max(
    MIN_MOMENTUM,
    Math.min(game.maxMomentum, game.momentum - deltas.momentum),
  );
  if (deltas.npcId) {
    const npc = game.npcs.find((n) => n.id === deltas.npcId);
    if (npc) {
      npc.bond = Math.max(0, Math.min(MAX_BOND, npc.bond - deltas.bond));
      if (deltas.dispositionFrom) npc.disposition = deltas.dispositionFrom;
    }
  }
  if (deltas.clockId) {
    const clock = game.clocks.find((c) => c.id === deltas.clockId);
    if (clock) clock.filled = Math.max(0, clock.filled - deltas.clockTicks);
  }
}

// ── Momentum Burn ────────────────────────────────────────────────────────────
/**
 * Burning momentum re-resolves the roll with momentum standing in for the action
 * score. It is offered only when that IMPROVES the outcome — which is what the
 * rank comparison says, where four flat `if`s said it as a truth table.
 */
export function canBurnMomentum(
  game: GameState,
  roll: Pick<RollResult, "result" | "c1" | "c2">,
): "STRONG_HIT" | "WEAK_HIT" | null {
  if (game.momentum <= 0) return null;
  const upgraded = resolveRoll(game.momentum, roll.c1, roll.c2);
  if (OUTCOME_RANK[upgraded] <= OUTCOME_RANK[roll.result]) return null;
  return upgraded === "MISS" ? null : upgraded;
}

// ── Kishotenketsu Probability ────────────────────────────────────────────────
const KISHOTENKETSU_PROB: Record<string, number> = {
  melancholic: 0.5,
  cozy: 0.4,
  romantic: 0.35,
  tragicomic: 0.3,
  slow_burn_horror: 0.25,
  cheerful_funny: 0.2,
  absurd_grotesque: 0.2,
};

export function chooseStoryStructure(
  tone: string,
  random: RandomSource = Math.random,
): "3act" | "kishotenketsu" {
  const prob = KISHOTENKETSU_PROB[tone] ?? 0.1;
  return random() < prob ? "kishotenketsu" : "3act";
}

export const RESULT_LABELS: Record<string, string> = {
  STRONG_HIT: "Strong Hit",
  WEAK_HIT: "Weak Hit",
  MISS: "Miss",
};
