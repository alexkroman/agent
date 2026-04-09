// ── Tuning Constants ─────────────────────────────────────────────────────────
export const MAX_ACTIVE_NPCS = 12;
export const MAX_SESSION_LOG = 50;
export const DIRECTOR_INTERVAL = 3;

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

export function creativitySeed(n = 3): string {
  const shuffled = [...SEED_WORDS].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n).join(" ");
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
  "dialog",
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
  dialog: "Dialog",
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
  instinct: string;
  status: "active" | "background" | "deceased";
  aliases: string[];
  lastMentionScene: number;
}

// ── Clock Interface ──────────────────────────────────────────────────────────
export interface Clock {
  id: string;
  name: string;
  clockType: "threat" | "progress" | "scheme";
  segments: number;
  filled: number;
  triggerDescription: string;
  owner: string;
}

// ── Story Blueprint ──────────────────────────────────────────────────────────
export interface StoryAct {
  phase: string;
  title: string;
  goal: string;
  mood: string;
  transitionTrigger: string;
}

export interface Revelation {
  id: string;
  content: string;
  earliestScene: number;
  dramaticWeight: "low" | "medium" | "high" | "critical";
  revealed: boolean;
}

export interface StoryBlueprint {
  structureType: "3act" | "kishotenketsu";
  centralConflict: string;
  antagonistForce: string;
  thematicThread: string;
  acts: StoryAct[];
  revelations: Revelation[];
  possibleEndings: { type: string; description: string }[];
  currentAct: number;
  storyComplete: boolean;
}

// ── Session Log Entry ────────────────────────────────────────────────────────
export interface SessionLogEntry {
  scene: number;
  summary: string;
  richSummary?: string;
  location: string;
  move?: string;
  result?: string;
}

// ── Game State ───────────────────────────────────────────────────────────────
export interface GameState {
  initialized: boolean;
  phase: "genre" | "tone" | "archetype" | "name" | "details" | "playing";
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
  locationHistory: string[];
  chaosFactor: number;
  crisisMode: boolean;
  gameOver: boolean;
  npcs: NPC[];
  clocks: Clock[];
  storyBlueprint: StoryBlueprint | null;
  chapterNumber: number;
  campaignHistory: { title: string; summary: string }[];
  sessionLog: SessionLogEntry[];
  narrationHistory: string[];
  directorGuidance: {
    narratorGuidance?: string;
    pacing?: string;
    arcNotes?: string;
  };
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
  momentum: 2,
  maxMomentum: 10,
  sceneCount: 0,
  currentLocation: "",
  currentSceneContext: "",
  timeOfDay: "",
  locationHistory: [],
  chaosFactor: 5,
  crisisMode: false,
  gameOver: false,
  npcs: [],
  clocks: [],
  storyBlueprint: null,
  chapterNumber: 1,
  campaignHistory: [],
  sessionLog: [],
  narrationHistory: [],
  directorGuidance: {},
  kidMode: false,
};

// ── KV helpers ───────────────────────────────────────────────────────────────
export type KV = {
  get: <T>(key: string) => Promise<T | null>;
  set: (key: string, value: unknown) => Promise<void>;
};

export const GAME_STATE_KEY = "rpg:state";

export async function getGameState(kv: KV): Promise<GameState> {
  const saved = await kv.get<GameState>(GAME_STATE_KEY);
  return saved ?? structuredClone(DEFAULT_STATE);
}

export async function saveGameState(kv: KV, state: GameState): Promise<void> {
  await kv.set(GAME_STATE_KEY, state);
}

// ── Helpers ──────────────────────────────────────────────────────────────────
export function d(sides: number): number {
  return Math.floor(Math.random() * sides) + 1;
}

export function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)] as T;
}

export function nextNpcId(npcs: NPC[]): string {
  let max = 0;
  for (const n of npcs) {
    const m = n.id.match(/^npc_(\d+)$/);
    if (m) max = Math.max(max, Number.parseInt(m[1]!, 10));
  }
  return `npc_${max + 1}`;
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
export function applyConsequences(
  game: GameState,
  roll: RollResult,
  position: string,
  effect: string,
  targetNpcId: string | null,
): { consequences: string[]; clockEvents: { clock: string; trigger: string }[] } {
  const consequences: string[] = [];
  const clockEvents: { clock: string; trigger: string }[] = [];
  const target = targetNpcId ? game.npcs.find((n) => n.id === targetNpcId) : null;

  if (roll.result === "MISS") {
    if (roll.move === "endure_harm") {
      const dmg = position === "desperate" ? 2 : 1;
      const old = game.health;
      game.health = Math.max(0, game.health - dmg);
      if (game.health < old) consequences.push(`health -${old - game.health}`);
    } else if (roll.move === "endure_stress") {
      const dmg = position === "desperate" ? 2 : 1;
      const old = game.spirit;
      game.spirit = Math.max(0, game.spirit - dmg);
      if (game.spirit < old) consequences.push(`spirit -${old - game.spirit}`);
    } else if (COMBAT_MOVES.has(roll.move)) {
      const dmg = position === "desperate" ? 3 : position === "controlled" ? 1 : 2;
      const old = game.health;
      game.health = Math.max(0, game.health - dmg);
      if (game.health < old) consequences.push(`health -${old - game.health}`);
    } else if (SOCIAL_MOVES.has(roll.move)) {
      if (target) {
        const oldBond = target.bond;
        target.bond = Math.max(0, target.bond - 1);
        if (target.bond < oldBond) consequences.push(`${target.name} bond -1`);
      }
      const dmg = position === "desperate" ? 2 : 1;
      const old = game.spirit;
      game.spirit = Math.max(0, game.spirit - dmg);
      if (game.spirit < old) consequences.push(`spirit -${old - game.spirit}`);
    } else {
      const oldSupply = game.supply;
      game.supply = Math.max(0, game.supply - 1);
      if (game.supply < oldSupply) consequences.push(`supply -${oldSupply - game.supply}`);
      if (position === "desperate") {
        const oldH = game.health;
        game.health = Math.max(0, game.health - 2);
        if (game.health < oldH) consequences.push(`health -${oldH - game.health}`);
      } else if (position !== "controlled") {
        const oldH = game.health;
        game.health = Math.max(0, game.health - 1);
        if (game.health < oldH) consequences.push(`health -${oldH - game.health}`);
      }
    }

    const momLoss = position === "desperate" ? 3 : 2;
    game.momentum = Math.max(-6, game.momentum - momLoss);
    consequences.push(`momentum -${momLoss}`);

    for (const clock of game.clocks) {
      if (clock.clockType === "threat" && clock.filled < clock.segments) {
        const ticks = position === "desperate" ? 2 : 1;
        clock.filled = Math.min(clock.segments, clock.filled + ticks);
        if (clock.filled >= clock.segments) {
          clockEvents.push({ clock: clock.name, trigger: clock.triggerDescription });
        }
        break;
      }
    }
  } else if (roll.result === "WEAK_HIT") {
    game.momentum = Math.min(game.maxMomentum, game.momentum + 1);
    if (roll.move === "make_connection" && target) {
      target.bond = Math.min(4, target.bond + 1);
    }
  } else {
    const momGain = effect === "great" ? 3 : 2;
    game.momentum = Math.min(game.maxMomentum, game.momentum + momGain);
    if ((roll.move === "make_connection" || roll.move === "compel") && target) {
      target.bond = Math.min(4, target.bond + 1);
      const shifts: Record<string, Disposition> = {
        hostile: "distrustful",
        distrustful: "neutral",
        neutral: "friendly",
        friendly: "loyal",
      };
      const nextDisposition = shifts[target.disposition];
      if (nextDisposition) target.disposition = nextDisposition;
    }
  }

  if (game.health <= 0 && game.spirit <= 0) {
    game.gameOver = true;
    game.crisisMode = true;
  } else if (game.health <= 0 || game.spirit <= 0) {
    game.crisisMode = true;
  } else {
    game.crisisMode = false;
  }

  return { consequences, clockEvents };
}

// ── Momentum Burn ────────────────────────────────────────────────────────────
export function canBurnMomentum(game: GameState, roll: RollResult): string | null {
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
