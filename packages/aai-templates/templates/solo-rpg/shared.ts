import type { ToolContext } from "@alexkroman1/aai";

// ── Tuning Constants ─────────────────────────────────────────────────────────
export const MAX_SESSION_LOG = 50;
export const MOMENTUM_RESET = 2;
export const MAX_RESOURCE = 5;
export const MIN_MOMENTUM = -6;
export const MAX_BOND = 4;
export const MAX_NPCS = 12;
export const MAX_CLOCKS = 8;
export const MIN_CLOCK_SEGMENTS = 2;
export const MAX_CLOCK_SEGMENTS = 12;

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

/** Unbiased Fisher-Yates shuffle. Returns a new array. */
export function shuffle<T>(arr: readonly T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export function creativitySeed(n = 3): string {
  return shuffle(SEED_WORDS).slice(0, n).join(" ");
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

export const MOVE_LABELS: Record<string, string> = {
  face_danger: "Face Danger",
  compel: "Compel",
  gather_information: "Gather Information",
  secure_advantage: "Secure Advantage",
  clash: "Clash",
  strike: "Strike",
  endure_harm: "Endure Harm",
  endure_stress: "Endure Stress",
  make_connection: "Make Connection",
  test_bond: "Test Bond",
  resupply: "Resupply",
  world_shaping: "World Shaping",
};

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
  initialized: boolean;
  phase: "genre" | "playing";
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
  phase: "genre",
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

// ── Live game state (ctx.state) ─────────────────────────────────────────────
// The in-play game lives in `ctx.state`, the agent's per-session mutable
// state — concurrent players get independent games by construction, and the
// live game needs no persistence of its own (that's what save slots are for).
export type StateSlot = { game?: GameState };

/** The session's live game. Mutations to the returned object stick — it is
 *  the object stored in `ctx.state`. */
export function getGameState(ctx: ToolContext): GameState {
  const slot = ctx.state as StateSlot;
  slot.game ??= structuredClone(DEFAULT_STATE);
  return slot.game;
}

/** Replace the session's live game wholesale (setup, load). */
export function saveGameState(ctx: ToolContext, state: GameState): void {
  (ctx.state as StateSlot).game = state;
}

// ── Persistent save slots (ctx.db) ───────────────────────────────────────────
// save_game / load_game are genuine cross-session persistence, so they use
// the app's SQL database. Requires storage: `aai storage enable` (or the
// Storage toggle in the studio); under `aai dev`, set DATABASE_URL in .env.
//
// Slots are keyed by name alone — the whole point of a save is loading it in
// a LATER session, whose sessionId differs, so the key can't embed one. The
// storage is per app, so every player of one deployment shares the slot
// namespace; without player identity that is the price of resumability.
export function saveSlotKey(slot?: string): string {
  return `save:${slot ?? "autosave"}`;
}

const ENSURE_APP_STATE = `create table if not exists app_state (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
)`;

// Memoized per process (each session's tools run in a fresh sandbox, so this
// is at most one round-trip per session); a failure clears the memo so the
// next call retries instead of caching the error forever.
let ensureP: Promise<unknown> | null = null;
function ensureTable(ctx: ToolContext): Promise<unknown> {
  ensureP ??= ctx.db.query(ENSURE_APP_STATE).catch((err) => {
    ensureP = null;
    throw err;
  });
  return ensureP;
}

/** Read one saved value. jsonb columns come back from the postgres driver
 *  already parsed, so the value needs no JSON.parse here. */
export async function loadState<T>(ctx: ToolContext, key: string): Promise<T | null> {
  await ensureTable(ctx);
  const rows = await ctx.db.query<{ value: T }>("select value from app_state where key = $1", [
    key,
  ]);
  return rows[0]?.value ?? null;
}

/** Upsert one value. Serialized explicitly and cast with `::jsonb` so the
 *  write is driver-agnostic about object parameters. */
export async function saveState(ctx: ToolContext, key: string, value: unknown): Promise<void> {
  await ensureTable(ctx);
  await ctx.db.query(
    "insert into app_state (key, value, updated_at) values ($1, $2::jsonb, now()) " +
      "on conflict (key) do update set value = excluded.value, updated_at = now()",
    [key, JSON.stringify(value)],
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────
export function d(sides: number): number {
  return Math.floor(Math.random() * sides) + 1;
}

export function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)] as T;
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

export function npcSummary(n: NPC) {
  return {
    id: n.id,
    name: n.name,
    disposition: n.disposition,
    bond: n.bond,
    agenda: n.agenda,
    status: n.status,
    description: n.description,
  };
}

export function clockSummary(c: Clock) {
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
export function stateSummary(state: GameState) {
  return {
    initialized: state.initialized,
    phase: state.phase,
    settingGenre: state.settingGenre,
    settingTone: state.settingTone,
    settingArchetype: state.settingArchetype,
    settingDescription: state.settingDescription,
    playerName: state.playerName,
    characterConcept: state.characterConcept,
    backstory: state.backstory,
    playerWishes: state.playerWishes,
    contentLines: state.contentLines,
    kidMode: state.kidMode,
    edge: state.edge,
    heart: state.heart,
    iron: state.iron,
    shadow: state.shadow,
    wits: state.wits,
    health: state.health,
    spirit: state.spirit,
    supply: state.supply,
    momentum: state.momentum,
    maxMomentum: state.maxMomentum,
    sceneCount: state.sceneCount,
    currentLocation: state.currentLocation,
    currentSceneContext: state.currentSceneContext,
    timeOfDay: state.timeOfDay,
    chaosFactor: state.chaosFactor,
    crisisMode: state.crisisMode,
    gameOver: state.gameOver,
    npcs: state.npcs.filter((n) => n.status !== "deceased").map(npcSummary),
    clocks: state.clocks.map(clockSummary),
    storyBlueprint: state.storyBlueprint
      ? {
          structureType: state.storyBlueprint.structureType,
          currentAct: state.storyBlueprint.currentAct,
          totalActs: state.storyBlueprint.acts.length,
          centralConflict: state.storyBlueprint.centralConflict,
          thematicThread: state.storyBlueprint.thematicThread,
          storyComplete: state.storyBlueprint.storyComplete,
          currentPhase: state.storyBlueprint.acts[state.storyBlueprint.currentAct - 1]?.phase,
        }
      : null,
    recentLog: state.sessionLog.slice(-5),
  };
}

// ── Dice System ──────────────────────────────────────────────────────────────
export function rollAction(statName: string, statValue: number, move: string) {
  const d1 = d(6),
    d2 = d(6);
  const c1 = d(10),
    c2 = d(10);
  const actionScore = Math.min(d1 + d2 + statValue, 10);
  let result: "STRONG_HIT" | "WEAK_HIT" | "MISS";
  if (actionScore > c1 && actionScore > c2) result = "STRONG_HIT";
  else if (actionScore > c1 || actionScore > c2) result = "WEAK_HIT";
  else result = "MISS";
  const match = c1 === c2;
  return { d1, d2, c1, c2, statName, statValue, actionScore, result, move, match };
}

export type RollResult = ReturnType<typeof rollAction>;

// ── Chaos Factor ─────────────────────────────────────────────────────────────
export function updateChaosFactor(game: GameState, result: string) {
  if (result === "MISS") game.chaosFactor = Math.min(9, game.chaosFactor + 1);
  else if (result === "STRONG_HIT") game.chaosFactor = Math.max(3, game.chaosFactor - 1);
}

export function checkChaosInterrupt(game: GameState): string | null {
  const threshold = game.chaosFactor - 3;
  if (threshold <= 0) return null;
  const roll = d(10);
  if (roll <= threshold) {
    game.chaosFactor = Math.max(3, game.chaosFactor - 1);
    return pick(CHAOS_INTERRUPT_TYPES);
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

export function updateCrisisFlags(game: GameState): void {
  if (game.health <= 0 && game.spirit <= 0) {
    game.gameOver = true;
    game.crisisMode = true;
  } else if (game.health <= 0 || game.spirit <= 0) {
    game.crisisMode = true;
  } else {
    game.crisisMode = false;
  }
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

  updateCrisisFlags(game);

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
  updateCrisisFlags(game);
}

// ── Momentum Burn ────────────────────────────────────────────────────────────
export function canBurnMomentum(
  game: GameState,
  roll: Pick<RollResult, "result" | "c1" | "c2">,
): "STRONG_HIT" | "WEAK_HIT" | null {
  if (game.momentum <= 0) return null;
  if (roll.result === "MISS" && game.momentum > roll.c1 && game.momentum > roll.c2)
    return "STRONG_HIT";
  if (roll.result === "MISS" && (game.momentum > roll.c1 || game.momentum > roll.c2))
    return "WEAK_HIT";
  if (roll.result === "WEAK_HIT" && game.momentum > roll.c1 && game.momentum > roll.c2)
    return "STRONG_HIT";
  return null;
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

export function chooseStoryStructure(tone: string): "3act" | "kishotenketsu" {
  const prob = KISHOTENKETSU_PROB[tone] ?? 0.1;
  return Math.random() < prob ? "kishotenketsu" : "3act";
}

export const RESULT_LABELS: Record<string, string> = {
  STRONG_HIT: "Strong Hit",
  WEAK_HIT: "Weak Hit",
  MISS: "Miss",
};
