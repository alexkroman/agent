import { defineToolFactory, defineAgent } from "@alexkroman1/aai";
import type { HookContext } from "@alexkroman1/aai";
import { z } from "zod";

// ── Tuning Constants ─────────────────────────────────────────────────────────
const STAT_TARGET_SUM = 7;
const MAX_ACTIVE_NPCS = 12;
const MAX_SESSION_LOG = 50;
const MAX_NARRATION_HISTORY = 6;
const DIRECTOR_INTERVAL = 3;

// ── Creativity Seeds ─────────────────────────────────────────────────────────
const SEED_WORDS = [
  "amber","coyote","furnace","silk","glacier","compass","terracotta","jasmine",
  "anvil","cobalt","driftwood","saffron","limestone","falcon","obsidian","cedar",
  "mercury","lantern","basalt","thistle","copper","monsoon","flint","orchid",
  "pewter","canyon","quartz","ember","mahogany","coral",
];

function creativitySeed(n = 3): string {
  const shuffled = [...SEED_WORDS].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n).join(" ");
}

// ── Genres, Tones, Archetypes (from engine i18n.py) ───────────────────────
const GENRES = {
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

const TONES = {
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

const ARCHETYPES = {
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

// ── Moves (from engine engine.py BRAIN_OUTPUT_SCHEMA) ─────────────────────
const MOVES = [
  "face_danger","compel","gather_information","secure_advantage",
  "clash","strike","endure_harm","endure_stress",
  "make_connection","test_bond","resupply","world_shaping","dialog",
] as const;

const COMBAT_MOVES = new Set(["clash", "strike"]);
const SOCIAL_MOVES = new Set(["compel", "make_connection", "test_bond"]);

const MOVE_LABELS: Record<string, string> = {
  face_danger: "Face Danger", compel: "Compel",
  gather_information: "Gather Information", secure_advantage: "Secure Advantage",
  clash: "Clash", strike: "Strike",
  endure_harm: "Endure Harm", endure_stress: "Endure Stress",
  make_connection: "Make Connection", test_bond: "Test Bond",
  resupply: "Resupply", world_shaping: "World Shaping", dialog: "Dialog",
};

// ── Time Phases (from engine engine.py) ───────────────────────────────────
const TIME_PHASES = [
  "early_morning","morning","midday","afternoon",
  "evening","late_evening","night","deep_night",
] as const;

const TIME_LABELS: Record<string, string> = {
  early_morning: "Early Morning", morning: "Morning", midday: "Midday",
  afternoon: "Afternoon", evening: "Evening", late_evening: "Late Evening",
  night: "Night", deep_night: "Deep Night",
};

// ── Chaos Interrupt Types (from engine engine.py) ─────────────────────────
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

// ── Disposition System (from engine engine.py) ────────────────────────────
const DISPOSITIONS = ["hostile","distrustful","neutral","friendly","loyal"] as const;
type Disposition = typeof DISPOSITIONS[number];

const DISPOSITION_LABELS: Record<Disposition, string> = {
  hostile: "Hostile", distrustful: "Distrustful", neutral: "Neutral",
  friendly: "Friendly", loyal: "Loyal",
};

// ── NPC Interface (from engine engine.py GameState.npcs) ──────────────────
interface NPC {
  id: string;
  name: string;
  description: string;
  disposition: Disposition;
  bond: number;        // -3 to +4
  agenda: string;
  instinct: string;
  status: "active" | "background" | "deceased";
  aliases: string[];
  lastMentionScene: number;
}

// ── Clock Interface (from engine engine.py) ───────────────────────────────
interface Clock {
  id: string;
  name: string;
  clockType: "threat" | "progress" | "scheme";
  segments: number;    // 4, 6, 8, 10, or 12
  filled: number;
  triggerDescription: string;
  owner: string;       // NPC id or "world"
}

// ── Story Blueprint (from engine STORY_ARCHITECT_OUTPUT_SCHEMA) ───────────
interface StoryAct {
  phase: string;
  title: string;
  goal: string;
  mood: string;
  transitionTrigger: string;
}

interface Revelation {
  id: string;
  content: string;
  earliestScene: number;
  dramaticWeight: "low" | "medium" | "high" | "critical";
  revealed: boolean;
}

interface StoryBlueprint {
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

// ── Session Log Entry (from engine engine.py session_log) ─────────────────
interface SessionLogEntry {
  scene: number;
  summary: string;
  richSummary?: string;
  location: string;
  move?: string;
  result?: string;
}

// ── Game State (from engine engine.py GameState dataclass) ─────────────────
interface GameState {
  initialized: boolean;
  phase: "genre" | "tone" | "archetype" | "name" | "details" | "playing";

  // Character creation choices
  settingGenre: string;
  settingTone: string;
  settingArchetype: string;
  settingDescription: string;

  // Character
  playerName: string;
  characterConcept: string;
  backstory: string;
  playerWishes: string;
  contentLines: string;

  // Stats (0-3, total = 7)
  edge: number;
  heart: number;
  iron: number;
  shadow: number;
  wits: number;

  // Tracks (0-5)
  health: number;
  spirit: number;
  supply: number;

  // Momentum (-6 to +10)
  momentum: number;
  maxMomentum: number;

  // Scene tracking
  sceneCount: number;
  currentLocation: string;
  currentSceneContext: string;
  timeOfDay: string;
  locationHistory: string[];

  // Chaos Factor (3-9, from Mythic GME)
  chaosFactor: number;

  // Crisis
  crisisMode: boolean;
  gameOver: boolean;

  // NPCs
  npcs: NPC[];

  // Clocks
  clocks: Clock[];

  // Story
  storyBlueprint: StoryBlueprint | null;
  chapterNumber: number;
  campaignHistory: { title: string; summary: string }[];

  // Session log
  sessionLog: SessionLogEntry[];
  narrationHistory: string[];

  // Director guidance
  directorGuidance: {
    narratorGuidance?: string;
    pacing?: string;
    arcNotes?: string;
  };

  // Kid mode
  kidMode: boolean;
}

const defaultState: GameState = {
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
  edge: 1, heart: 2, iron: 1, shadow: 1, wits: 2,
  health: 5, spirit: 5, supply: 5,
  momentum: 2, maxMomentum: 10,
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

const gameTool = defineToolFactory<GameState>();

// ── Helpers ──────────────────────────────────────────────────────────────────
function d(sides: number): number {
  return Math.floor(Math.random() * sides) + 1;
}

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)] as T;
}

function nextNpcId(npcs: NPC[]): string {
  let max = 0;
  for (const n of npcs) {
    const m = n.id.match(/^npc_(\d+)$/);
    if (m) max = Math.max(max, parseInt(m[1]!));
  }
  return `npc_${max + 1}`;
}

// ── Dice System (from engine engine.py roll_action) ───────────────────────
// 2d6 + stat (capped at 10) vs 2d10
function rollAction(statName: string, statValue: number, move: string) {
  const d1 = d(6), d2 = d(6);
  const c1 = d(10), c2 = d(10);
  const actionScore = Math.min(d1 + d2 + statValue, 10);
  let result: "STRONG_HIT" | "WEAK_HIT" | "MISS";
  if (actionScore > c1 && actionScore > c2) result = "STRONG_HIT";
  else if (actionScore > c1 || actionScore > c2) result = "WEAK_HIT";
  else result = "MISS";
  const match = c1 === c2;
  return { d1, d2, c1, c2, statName, statValue, actionScore, result, move, match };
}

type RollResult = ReturnType<typeof rollAction>;

// ── Chaos Factor (from engine engine.py) ──────────────────────────────────
function updateChaosFactor(game: GameState, result: string) {
  if (result === "MISS") game.chaosFactor = Math.min(9, game.chaosFactor + 1);
  else if (result === "STRONG_HIT") game.chaosFactor = Math.max(3, game.chaosFactor - 1);
}

function checkChaosInterrupt(game: GameState): string | null {
  const threshold = game.chaosFactor - 3;
  if (threshold <= 0) return null;
  const roll = d(10);
  if (roll <= threshold) {
    game.chaosFactor = Math.max(3, game.chaosFactor - 1);
    return pick(CHAOS_INTERRUPT_TYPES);
  }
  return null;
}

// ── Time Advancement (from engine engine.py) ──────────────────────────────
function advanceTime(game: GameState, progression: string) {
  if (!game.timeOfDay || progression === "none" || progression === "short") return;
  const idx = (TIME_PHASES as readonly string[]).indexOf(game.timeOfDay);
  if (idx === -1) return;
  const steps = progression === "moderate" ? 1 : progression === "long" ? 2 : 0;
  if (steps) {
    const newIdx = (idx + steps) % TIME_PHASES.length;
    game.timeOfDay = TIME_PHASES[newIdx] as string;
  }
}

// ── Consequences (from engine engine.py apply_consequences) ───────────────
function applyConsequences(
  game: GameState,
  roll: RollResult,
  position: string,
  effect: string,
  targetNpcId: string | null,
): { consequences: string[]; clockEvents: { clock: string; trigger: string }[] } {
  const consequences: string[] = [];
  const clockEvents: { clock: string; trigger: string }[] = [];
  const target = targetNpcId ? game.npcs.find(n => n.id === targetNpcId) : null;

  if (roll.result === "MISS") {
    // Damage based on move type and position
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
      // General miss: supply loss + position-scaled health loss
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

    // Momentum loss on miss
    const momLoss = position === "desperate" ? 3 : 2;
    game.momentum = Math.max(-6, game.momentum - momLoss);
    consequences.push(`momentum -${momLoss}`);

    // Advance first threat clock
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
    // Momentum +1 on weak hit
    game.momentum = Math.min(game.maxMomentum, game.momentum + 1);
    if (roll.move === "make_connection" && target) {
      target.bond = Math.min(4, target.bond + 1);
    }
  } else {
    // STRONG_HIT: momentum gain scaled by effect
    const momGain = effect === "great" ? 3 : 2;
    game.momentum = Math.min(game.maxMomentum, game.momentum + momGain);
    if ((roll.move === "make_connection" || roll.move === "compel") && target) {
      target.bond = Math.min(4, target.bond + 1);
      // Disposition shift on strong social hit
      const shifts: Record<string, Disposition> = {
        hostile: "distrustful", distrustful: "neutral",
        neutral: "friendly", friendly: "loyal",
      };
      const nextDisposition = shifts[target.disposition];
      if (nextDisposition) target.disposition = nextDisposition;
    }
  }

  // Crisis check
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

// ── Momentum Burn (from engine engine.py can_burn_momentum) ───────────────
function canBurnMomentum(game: GameState, roll: RollResult): string | null {
  if (game.momentum <= 0) return null;
  if (roll.result === "MISS" && game.momentum > roll.c1 && game.momentum > roll.c2) return "STRONG_HIT";
  if (roll.result === "MISS" && (game.momentum > roll.c1 || game.momentum > roll.c2)) return "WEAK_HIT";
  if (roll.result === "WEAK_HIT" && game.momentum > roll.c1 && game.momentum > roll.c2) return "STRONG_HIT";
  return null;
}

// ── Kishotenketsu Probability (from engine engine.py) ─────────────────────
const KISHOTENKETSU_PROB: Record<string, number> = {
  melancholic: 0.5, cozy: 0.4, romantic: 0.35, tragicomic: 0.3,
  slow_burn_horror: 0.25, cheerful_funny: 0.2, absurd_grotesque: 0.2,
};

function chooseStoryStructure(tone: string): "3act" | "kishotenketsu" {
  const prob = KISHOTENKETSU_PROB[tone] ?? 0.1;
  return Math.random() < prob ? "kishotenketsu" : "3act";
}

// ═══════════════════════════════════════════════════════════════════════════════
// AGENT DEFINITION
// ═══════════════════════════════════════════════════════════════════════════════

export default defineAgent({
  name: "Solo RPG",

  systemPrompt: `You are the Narrator of a solo tabletop RPG engine. You guide the player through a narrative adventure using proven game mechanics adapted from Ironsworn/Starforged, Mythic GME, and Blades in the Dark.

CHARACTER CREATION — ONE TURN SETUP:
The player only needs to give you ONE thing to start: a name, a genre, a character idea, or just say "go". That is enough. You fill in the rest.

From whatever the player gives you, infer the best genre, tone, and archetype. If they say "cyberpunk hacker named Kai", you have everything. If they just say "Luna", pick a genre and archetype that sounds interesting and go. If they say "surprise me", pick everything yourself.

Available genres: ${Object.values(GENRES).join(", ")}.
Available tones: ${Object.values(TONES).join(", ")}.
Available archetypes: ${Object.values(ARCHETYPES).join(", ")}.

Once you have the player's input, immediately call setup_character with ALL fields filled in: genre, tone, archetype, playerName, characterConcept, settingDescription, startingLocation, locationDesc, timeOfDay, openingSituation, npc1Name, npc1Desc, npc1Disposition, npc1Agenda, threatClockName, threatClockDesc. You must generate all of these yourself based on the player's input. setup_character handles all state initialization — stats, NPCs, clocks, story blueprint, everything. After it returns, just narrate the opening scene. Do NOT call update_state after setup_character — it is already done.

Do all of this in ONE turn. Never ask follow-up questions before starting. The player can always change things later by telling you.

IMPORTANT FOR SPEECH: Never list more than three or four options. Keep all responses punchy and conversational. No long lists — they sound terrible spoken aloud.

CORE MECHANIC - ACTION ROLL (Ironsworn):
When the player attempts something risky, use the action_roll tool. You choose the move and stat:
- edge for speed, agility, precision, ranged combat
- heart for courage, willpower, empathy, leadership
- iron for strength, endurance, melee combat
- shadow for stealth, deception, cunning
- wits for expertise, knowledge, observation

The system rolls 2d6 + stat (capped at 10) vs 2d10.
- Strong Hit: beat both d10s. Clean success.
- Weak Hit: beat one d10. Success with a cost or complication.
- Miss: beat neither. Failure with consequences.
- Match (both d10s same): amplifies the result. Strong Hit + Match = exceptional. Miss + Match = dire escalation.

MOVES (12 mechanical actions + dialog):
- face_danger: overcome obstacles, act under pressure
- gather_information: search, investigate, observe
- secure_advantage: prepare, scout, gain edge
- world_shaping: player introduces new world elements
- compel: persuade, negotiate, manipulate
- make_connection: bond with someone, establish relationship
- test_bond: rely on relationship, call in favor
- clash: opposed combat (melee/range)
- strike: attack when opponent cannot react
- endure_harm: suffer physical damage
- endure_stress: suffer mental/emotional damage
- resupply: restore supply track
- dialog: pure conversation, no risk, no roll

POSITION & EFFECT (Blades in the Dark):
Every risky action has a position and effect:
Position (how dangerous):
- Controlled: upper hand, failure is mild
- Risky: default, real consequences on failure
- Desperate: in trouble, failure hits hard

Effect (what can be achieved):
- Limited: partial success even on strong hit
- Standard: full success as described
- Great: exceeds expectations, bonus outcome

Position scales damage on miss. Effect scales momentum gain on strong hit.

MOMENTUM (Ironsworn):
- Starts at 2, range -6 to +10
- Weak Hit: +1. Strong Hit: +2 (or +3 with great effect)
- Miss: -2 (or -3 if desperate)
- Burn: player can spend momentum to upgrade a result if momentum beats both challenge dice. Resets to +2 after burn.

CHAOS FACTOR (Mythic GME):
- Range 3-9, starts at 5
- Miss: chaos +1 (max 9). Strong Hit: chaos -1 (min 3). Weak Hit: no change.
- Scene interrupt probability: (chaos - 3) x 10%. Chaos 5 = 20%, chaos 9 = 60%.
- When interrupt triggers, something unexpected disrupts the scene.

CLOCKS (Blades in the Dark):
Clocks track threats, progress, and NPC schemes:
- Threat clocks advance on misses. When full, the threat strikes.
- Progress clocks track long-term goals.
- Scheme clocks track NPC agendas (advance every 5 scenes).

NPCs:
NPCs have dispositions: hostile, distrustful, neutral, friendly, loyal.
Social strong hits shift disposition favorably. Social misses damage bonds.
NPCs have agendas and instincts that drive their behavior.
Track up to ${MAX_ACTIVE_NPCS} active NPCs.

CRISIS:
- Health or spirit at 0 = crisis mode. Both at 0 = game over.
- In crisis, every miss is more dangerous.

KID MODE:
If kidMode is true: no explicit violence, no death, hopeful tone, age-appropriate content. Enemies are "defeated" not "killed". Think Studio Ghibli, Zelda.

STORY BLUEPRINT:
The story follows either a 3-act structure or Kishotenketsu (4-part). Created at game start. Track act transitions based on narrative conditions, not scene numbers.

CORRECTION SYSTEM:
If the player starts a message with ##, treat it as a correction to the previous turn. Acknowledge the correction and rewrite the scene.

FLOW:
1. check_state is automatically forced as your first tool call every turn. Read the returned values as ground truth. NEVER remember or guess stats from prior turns.
2. Present situations with tension and choice. Two to three options, but accept anything.
3. For ANY risky action, you MUST call action_roll. NEVER narrate success or failure without rolling. NEVER reduce health, spirit, supply, or momentum yourself — action_roll does this through code. If you narrate damage without calling action_roll, the sidebar will be wrong and the game will break.
4. After location changes, new NPCs, or other world changes, call update_state. But NEVER manually set health, spirit, supply, or momentum in update_state unless the player is resting or trading — action_roll handles combat and risk.
5. The chaos interrupt check happens automatically inside action_roll. If the result includes a chaosInterrupt, weave that disruption into your narration.
6. Every ${DIRECTOR_INTERVAL} scenes, consider story arc progression and NPC development via update_state.

VOICE:
- Keep narration to 2-4 sentences. Optimized for spoken conversation.
- Short, punchy sentences. No visual formatting.
- Never mention "search results" or "sources".
- No exclamation points. Calm, conversational tone.
- One vivid detail per scene. Let the player's imagination do the rest.
- NPCs speak in character. Brief, natural dialog fragments.
- Never over-describe. If the player wants more detail, they will ask.
- Describe consequences naturally within the narration, do not list them.`,

  greeting:
    "Welcome. Tell me your name, or describe the kind of story you want, and we will begin. You can say something like, dark fantasy warrior named Kael, or just give me a name and I will build a world around you.",

  sttPrompt:
    "Solo RPG terms: strong hit, weak hit, miss, momentum, chaos factor, clock, disposition, bond, edge, heart, iron, shadow, wits, face danger, compel, gather information, secure advantage, clash, strike, endure harm, endure stress, make connection, test bond, resupply, world shaping",

  builtinTools: ["run_code"],
  maxSteps: 8,

  state: () => structuredClone(defaultState),

  // Auto-load saved game on connect (restores game state from KV).
  onConnect: async (ctx: HookContext<GameState>) => {
    const saved = await ctx.kv.get<GameState>("save:game");
    if (saved) Object.assign(ctx.state, saved);
  },

  // Auto-save after every turn so progress persists across browser refreshes.
  onUserTranscript: async (_text: string, ctx: HookContext<GameState>) => {
    if (ctx.state.initialized) {
      await ctx.kv.set("save:game", ctx.state);
    }
  },

  tools: {
    check_state: {
      description:
        "Returns the full current game state. This is AUTOMATICALLY forced as the first tool call every turn. Use these numbers as ground truth — never guess or remember stats from previous turns.",
      execute: (_args, ctx) => {
        const s = ctx.state;
        return {
          initialized: s.initialized,
          phase: s.phase,
          settingGenre: s.settingGenre,
          settingTone: s.settingTone,
          settingArchetype: s.settingArchetype,
          playerName: s.playerName,
          characterConcept: s.characterConcept,
          edge: s.edge, heart: s.heart, iron: s.iron, shadow: s.shadow, wits: s.wits,
          health: s.health, spirit: s.spirit, supply: s.supply,
          momentum: s.momentum, maxMomentum: s.maxMomentum,
          sceneCount: s.sceneCount,
          currentLocation: s.currentLocation,
          timeOfDay: s.timeOfDay,
          chaosFactor: s.chaosFactor,
          crisisMode: s.crisisMode,
          gameOver: s.gameOver,
          npcs: s.npcs.filter(n => n.status !== "deceased").map(n => ({
            id: n.id, name: n.name, disposition: n.disposition,
            bond: n.bond, agenda: n.agenda, status: n.status,
          })),
          clocks: s.clocks.filter(c => c.filled < c.segments).map(c => ({
            name: c.name, type: c.clockType,
            filled: c.filled, segments: c.segments,
          })),
          storyAct: s.storyBlueprint ? {
            current: s.storyBlueprint.currentAct,
            total: s.storyBlueprint.acts.length,
            phase: s.storyBlueprint.acts[s.storyBlueprint.currentAct - 1]?.phase,
            complete: s.storyBlueprint.storyComplete,
          } : null,
          kidMode: s.kidMode,
          directorGuidance: s.directorGuidance,
          recentLog: s.sessionLog.slice(-3),
        };
      },
    },

    setup_character: gameTool({
      description:
        "Set up the entire game in one call. Generates stats, initializes state, and marks the game as ready. After this returns, just narrate the opening scene. No need to call update_state — everything is already done.",
      parameters: z.object({
        genre: z.string().describe("Chosen genre code or custom description"),
        tone: z.string().describe("Chosen tone code or custom description"),
        archetype: z.string().describe("Chosen archetype code or custom description"),
        playerName: z.string().describe("Character name"),
        characterConcept: z.string().describe("One-line character concept"),
        settingDescription: z.string().describe("Two to three sentence setting description"),
        startingLocation: z.string().describe("Name of starting location"),
        locationDesc: z.string().describe("One sentence description of starting location"),
        timeOfDay: z.enum(["early_morning","morning","midday","afternoon","evening","late_evening","night","deep_night"]).describe("Starting time of day"),
        openingSituation: z.string().describe("One sentence dramatic hook for the opening scene"),
        npc1Name: z.string().describe("First NPC name"),
        npc1Desc: z.string().describe("First NPC one-line description"),
        npc1Disposition: z.enum(DISPOSITIONS).describe("First NPC disposition"),
        npc1Agenda: z.string().describe("First NPC agenda"),
        threatClockName: z.string().describe("Name of initial threat clock"),
        threatClockDesc: z.string().describe("What happens when the threat clock fills"),
        threatClockSegments: z.number().optional().describe("Segments for threat clock, default 6"),
        backstory: z.string().optional(),
        wishes: z.string().optional(),
        contentLines: z.string().optional(),
        kidMode: z.boolean().optional(),
      }),
      execute: (args, ctx) => {
        const state = ctx.state;

        // Store creation choices
        state.settingGenre = args.genre;
        state.settingTone = args.tone;
        state.settingArchetype = args.archetype;
        state.playerName = args.playerName;
        state.characterConcept = args.characterConcept;
        state.settingDescription = args.settingDescription;
        state.backstory = args.backstory || "";
        state.playerWishes = args.wishes || "";
        state.contentLines = args.contentLines || "";
        state.kidMode = args.kidMode || false;

        // Generate stats: one at 3, two at 2, two at 1 (total = 7)
        const statValues = [3, 2, 2, 1, 1];
        for (let i = statValues.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [statValues[i], statValues[j]] = [statValues[j]!, statValues[i]!];
        }
        const archetypeBias: Record<string, number> = {
          outsider_loner: 0, investigator: 4, trickster: 3,
          protector: 2, hardboiled: 2, scholar: 4,
          healer: 1, inventor: 4, artist: 1,
        };
        const biasIdx = archetypeBias[args.archetype] ?? Math.floor(Math.random() * 5);
        const highIdx = statValues.indexOf(3);
        if (highIdx !== biasIdx) {
          [statValues[highIdx], statValues[biasIdx]] = [statValues[biasIdx]!, statValues[highIdx]!];
        }
        state.edge = statValues[0]!;
        state.heart = statValues[1]!;
        state.iron = statValues[2]!;
        state.shadow = statValues[3]!;
        state.wits = statValues[4]!;

        // Set location, time
        state.currentLocation = args.startingLocation;
        state.currentSceneContext = args.locationDesc;
        state.timeOfDay = args.timeOfDay;

        // Add initial NPC
        state.npcs.push({
          id: "npc_1",
          name: args.npc1Name,
          description: args.npc1Desc,
          disposition: args.npc1Disposition,
          bond: args.npc1Disposition === "friendly" ? 1 : args.npc1Disposition === "loyal" ? 2 : 0,
          agenda: args.npc1Agenda,
          instinct: "",
          status: "active",
          aliases: [],
          lastMentionScene: 0,
        });

        // Add threat clock
        state.clocks.push({
          id: "clock_1",
          name: args.threatClockName,
          clockType: "threat",
          segments: args.threatClockSegments || 6,
          filled: 0,
          triggerDescription: args.threatClockDesc,
          owner: "world",
        });

        // Story blueprint (simple 3-act)
        const structure = chooseStoryStructure(args.tone);
        state.storyBlueprint = {
          structureType: structure,
          centralConflict: args.openingSituation,
          antagonistForce: "",
          thematicThread: "",
          acts: structure === "3act"
            ? [
              { phase: "setup", title: "The Hook", goal: "Establish the world and the conflict", mood: args.tone, transitionTrigger: "Player engages with the central conflict" },
              { phase: "confrontation", title: "Rising Stakes", goal: "Escalate tension and complications", mood: args.tone, transitionTrigger: "A major setback or revelation" },
              { phase: "climax", title: "The Reckoning", goal: "Resolve the central conflict", mood: args.tone, transitionTrigger: "Story reaches its conclusion" },
            ]
            : [
              { phase: "ki_introduction", title: "Ki", goal: "Introduce the world and characters", mood: args.tone, transitionTrigger: "World is established" },
              { phase: "sho_development", title: "Sho", goal: "Develop relationships and deepen the world", mood: args.tone, transitionTrigger: "Relationships are tested" },
              { phase: "ten_twist", title: "Ten", goal: "An unexpected twist changes everything", mood: args.tone, transitionTrigger: "The twist lands" },
              { phase: "ketsu_resolution", title: "Ketsu", goal: "Resolve and reflect", mood: args.tone, transitionTrigger: "Story reaches its conclusion" },
            ],
          revelations: [],
          possibleEndings: [],
          currentAct: 1,
          storyComplete: false,
        };

        // Mark initialized
        state.initialized = true;
        state.phase = "playing";
        state.sceneCount = 1;

        return {
          success: true,
          initialized: true,
          playerName: state.playerName,
          characterConcept: state.characterConcept,
          settingGenre: GENRES[args.genre as keyof typeof GENRES] || args.genre,
          settingTone: TONES[args.tone as keyof typeof TONES] || args.tone,
          settingArchetype: ARCHETYPES[args.archetype as keyof typeof ARCHETYPES] || args.archetype,
          settingDescription: state.settingDescription,
          stats: { edge: state.edge, heart: state.heart, iron: state.iron, shadow: state.shadow, wits: state.wits },
          health: 5, spirit: 5, supply: 5, momentum: 2,
          currentLocation: state.currentLocation,
          currentSceneContext: state.currentSceneContext,
          timeOfDay: state.timeOfDay,
          chaosFactor: 5,
          npcs: state.npcs.map(n => ({ id: n.id, name: n.name, disposition: n.disposition, bond: n.bond, agenda: n.agenda, status: n.status, description: n.description })),
          clocks: state.clocks.map(c => ({ id: c.id, name: c.name, clockType: c.clockType, segments: c.segments, filled: c.filled, triggerDescription: c.triggerDescription })),
          storyBlueprint: { structureType: state.storyBlueprint.structureType, currentAct: 1, totalActs: state.storyBlueprint.acts.length, centralConflict: state.storyBlueprint.centralConflict, thematicThread: "", storyComplete: false, currentPhase: state.storyBlueprint.acts[0]!.phase },
          openingSituation: args.openingSituation,
          creativitySeed: creativitySeed(),
          phase: "playing",
          sceneCount: 1,
          kidMode: state.kidMode,
        };
      },
    }),

    action_roll: gameTool({
      description:
        "Core mechanic. Roll 2d6 + stat (capped at 10) vs 2d10 challenge dice. Also applies consequences (health/spirit/supply/momentum changes, clock advancement) based on move type, position, and result. Call for ANY risky action.",
      parameters: z.object({
        move: z.enum(MOVES).describe("Which move the player is making"),
        stat: z.enum(["edge","heart","iron","shadow","wits"]).describe("Which stat to roll"),
        position: z.enum(["controlled","risky","desperate"]).describe("How dangerous the situation is"),
        effect: z.enum(["limited","standard","great"]).describe("What can realistically be achieved"),
        purpose: z.string().describe("What the character is attempting"),
        targetNpcId: z.string().optional().describe("Target NPC id for social moves"),
      }),
      execute: ({ move, stat, position, effect, purpose, targetNpcId }, ctx) => {
        const state = ctx.state;
        const statValue = state[stat as keyof GameState] as number;
        const roll = rollAction(stat, statValue, move);

        // Apply consequences
        const { consequences, clockEvents } = applyConsequences(
          state, roll, position, effect, targetNpcId || null,
        );

        // Update chaos factor
        updateChaosFactor(state, roll.result);

        // Check for chaos interrupt
        const interrupt = checkChaosInterrupt(state);

        // Increment scene count
        state.sceneCount++;

        // Can burn momentum?
        const burnTarget = canBurnMomentum(state, roll);

        // Result labels
        const resultLabels: Record<string, string> = {
          STRONG_HIT: "Strong Hit", WEAK_HIT: "Weak Hit", MISS: "Miss",
        };

        return {
          purpose,
          move: MOVE_LABELS[move] || move,
          moveCode: move,
          stat,
          statValue,
          actionDice: [roll.d1, roll.d2],
          challengeDice: [roll.c1, roll.c2],
          actionScore: roll.actionScore,
          result: resultLabels[roll.result],
          resultCode: roll.result,
          match: roll.match,
          matchNote: roll.match
            ? (roll.result === "STRONG_HIT" || roll.result === "WEAK_HIT"
              ? "Fateful roll. Both challenge dice match. An unexpected advantage or twist."
              : "Fateful roll. Both challenge dice match. A dire and dramatic escalation.")
            : undefined,
          position,
          effect,
          consequences,
          clockEvents,
          chaosInterrupt: interrupt,
          currentHealth: state.health,
          currentSpirit: state.spirit,
          currentSupply: state.supply,
          currentMomentum: state.momentum,
          chaosFactor: state.chaosFactor,
          crisisMode: state.crisisMode,
          gameOver: state.gameOver,
          sceneCount: state.sceneCount,
          canBurnMomentum: !!burnTarget,
          burnWouldYield: burnTarget ? resultLabels[burnTarget] : undefined,
        };
      },
    }),

    burn_momentum: gameTool({
      description:
        "Burn momentum to upgrade a roll result. Only valid when current momentum beats both challenge dice for the roll being upgraded. Resets momentum to +2.",
      parameters: z.object({
        c1: z.number().describe("First challenge die from the roll"),
        c2: z.number().describe("Second challenge die from the roll"),
      }),
      execute: ({ c1, c2 }, ctx) => {
        const state = ctx.state;
        const mom = state.momentum;
        if (mom <= 0) return { error: "Momentum is 0 or negative. Cannot burn." };

        let newResult: string;
        if (mom > c1 && mom > c2) newResult = "STRONG_HIT";
        else if (mom > c1 || mom > c2) newResult = "WEAK_HIT";
        else return { error: "Momentum not high enough to improve the result." };

        const previousMomentum = mom;
        state.momentum = 2; // Reset to starting value

        const labels: Record<string, string> = {
          STRONG_HIT: "Strong Hit", WEAK_HIT: "Weak Hit",
        };

        return {
          burned: true,
          previousMomentum,
          newMomentum: 2,
          newResult: labels[newResult],
          newResultCode: newResult,
          challengeDice: [c1, c2],
        };
      },
    }),

    oracle: gameTool({
      description:
        "Consult the oracle for narrative inspiration. Generates random prompts from thematic tables.",
      parameters: z.object({
        type: z.enum(["action_theme","npc_reaction","scene_twist","yes_no","chaos_check"]).describe("Type of oracle consultation"),
      }),
      execute: ({ type }, ctx) => {
        const state = ctx.state;

        if (type === "yes_no") {
          const roll = d(6);
          const answer = roll <= 2 ? "No" : roll <= 4 ? "Yes, but with a complication" : "Yes";
          return { type: "yes_no", roll, answer };
        }

        if (type === "chaos_check") {
          const interrupt = checkChaosInterrupt(state);
          return {
            type: "chaos_check",
            chaosFactor: state.chaosFactor,
            interrupted: !!interrupt,
            interruptType: interrupt,
          };
        }

        if (type === "npc_reaction") {
          const reactions = [
            "Acts on their agenda","Reveals a secret","Makes a demand",
            "Offers unexpected help","Betrays expectations","Shows vulnerability",
            "Escalates the conflict","Withdraws or retreats","Changes their stance",
            "Introduces a new complication",
          ];
          return { type: "npc_reaction", reaction: pick(reactions) };
        }

        if (type === "scene_twist") {
          const twists = [
            "A hidden connection is revealed","The environment shifts dramatically",
            "An NPC's true motives surface","Time pressure intensifies",
            "An old enemy reappears","A resource is discovered or lost",
            "The rules of the world bend","An alliance fractures",
            "A prophecy or omen manifests","The stakes escalate unexpectedly",
          ];
          return { type: "scene_twist", twist: pick(twists) };
        }

        // action_theme (default)
        const actions = [
          "Abandon","Advance","Assault","Betray","Block","Bolster","Breach",
          "Capture","Challenge","Change","Clash","Command","Compel","Conceal",
          "Confront","Control","Corrupt","Create","Deceive","Defend","Defy",
          "Deliver","Demand","Depart","Destroy","Distract","Endure","Escape",
          "Explore","Falter","Find","Follow","Forge","Forsake","Gather","Guard",
          "Guide","Harm","Hide","Hold","Hunt","Investigate","Journey","Learn",
          "Leave","Locate","Lose","Manipulate","Move","Oppose","Overwhelm",
          "Persevere","Plunder","Preserve","Protect","Rage","Reach","Reclaim",
          "Refuse","Reject","Release","Repair","Resist","Restore","Reveal",
          "Risk","Salvage","Scheme","Search","Secure","Seize","Serve","Share",
          "Shatter","Shelter","Strengthen","Summon","Surrender","Surround",
          "Survive","Swear","Threaten","Track","Transform","Trap","Traverse",
          "Uncover","Uphold","Weaken","Withdraw",
        ];
        const themes = [
          "Ancestor","Ash","Beast","Blood","Bone","Burden","Communion",
          "Corruption","Crown","Darkness","Death","Debt","Decay","Despair",
          "Divinity","Doom","Dream","Dynasty","Eclipse","Exile","Faith","Fate",
          "Flesh","Fury","Grace","Grief","Guilt","Heritage","Hollow","Honor",
          "Horror","Hunger","Iron","Judgment","Kingdom","Knowledge","Legacy",
          "Loss","Madness","Memory","Mercy","Monster","Mystery","Night","Oath",
          "Omen","Order","Passage","Peril","Plague","Power","Pride","Prophecy",
          "Rebirth","Relic","Rot","Ruin","Sacrifice","Scar","Secret","Shadow",
          "Shard","Silence","Sorrow","Spirit","Splendor","Storm","Throne",
          "Time","Treachery","Truth","Valor","Vengeance","War","Waste","Winter",
          "Wisdom","Wound",
        ];
        return {
          type: "action_theme",
          action: pick(actions),
          theme: pick(themes),
          seed: creativitySeed(),
        };
      },
    }),

    update_state: gameTool({
      description:
        "Lightweight state sync for during gameplay. Handles location changes, NPC additions, clock additions, time changes, and session log entries. Resource changes (health/spirit/supply/momentum) are auto-applied by action_roll — only use those fields here for manual adjustments like resting or trading. Pass only what changed.",
      parameters: z.object({
        // Location & time
        location: z.string().optional().describe("New location name"),
        locationDesc: z.string().optional().describe("Short location description"),
        timeOfDay: z.string().optional().describe("New time of day"),
        // Manual resource adjustments (resting, trading, etc.)
        health: z.number().optional(),
        spirit: z.number().optional(),
        supply: z.number().optional(),
        momentum: z.number().optional(),
        // Add a new NPC (name + description + disposition + agenda)
        addNpcName: z.string().optional().describe("New NPC name"),
        addNpcDesc: z.string().optional().describe("New NPC one-line description"),
        addNpcDisposition: z.enum(DISPOSITIONS).optional().describe("New NPC disposition"),
        addNpcAgenda: z.string().optional().describe("New NPC agenda"),
        // Update existing NPC
        updateNpcId: z.string().optional().describe("NPC id to update"),
        updateNpcDisposition: z.enum(DISPOSITIONS).optional(),
        updateNpcBond: z.number().optional(),
        updateNpcStatus: z.enum(["active","background","deceased"]).optional(),
        // Add a new clock
        addClockName: z.string().optional().describe("New clock name"),
        addClockType: z.enum(["threat","progress","scheme"]).optional(),
        addClockSegments: z.number().optional().describe("Number of segments, default 6"),
        addClockTrigger: z.string().optional().describe("What happens when clock fills"),
        // Advance or remove clock
        advanceClockName: z.string().optional().describe("Clock name to advance by 1"),
        removeClockName: z.string().optional().describe("Clock name to remove"),
        // Story arc
        advanceAct: z.boolean().optional().describe("Move to next story act"),
        storyComplete: z.boolean().optional().describe("Mark story as complete"),
        // Session log
        logEntry: z.string().optional().describe("Short log entry for this scene"),
      }),
      execute: (args, ctx) => {
        const state = ctx.state;

        // Resources
        if (args.health !== undefined) state.health = Math.max(0, Math.min(5, args.health));
        if (args.spirit !== undefined) state.spirit = Math.max(0, Math.min(5, args.spirit));
        if (args.supply !== undefined) state.supply = Math.max(0, Math.min(5, args.supply));
        if (args.momentum !== undefined) state.momentum = Math.max(-6, Math.min(state.maxMomentum, args.momentum));

        // Location
        if (args.location !== undefined) {
          if (state.currentLocation && state.currentLocation !== args.location) {
            state.locationHistory.push(state.currentLocation);
            if (state.locationHistory.length > 5) state.locationHistory = state.locationHistory.slice(-5);
          }
          state.currentLocation = args.location;
        }
        if (args.locationDesc !== undefined) state.currentSceneContext = args.locationDesc;
        if (args.timeOfDay !== undefined) state.timeOfDay = args.timeOfDay;

        // Add NPC
        if (args.addNpcName) {
          const id = nextNpcId(state.npcs);
          state.npcs.push({
            id, name: args.addNpcName,
            description: args.addNpcDesc || "",
            disposition: args.addNpcDisposition || "neutral",
            bond: (args.addNpcDisposition === "friendly") ? 1 : (args.addNpcDisposition === "loyal") ? 2 : 0,
            agenda: args.addNpcAgenda || "", instinct: "",
            status: "active", aliases: [], lastMentionScene: state.sceneCount,
          });
        }

        // Update NPC
        if (args.updateNpcId) {
          const npc = state.npcs.find(n => n.id === args.updateNpcId);
          if (npc) {
            if (args.updateNpcDisposition !== undefined) npc.disposition = args.updateNpcDisposition;
            if (args.updateNpcBond !== undefined) npc.bond = args.updateNpcBond;
            if (args.updateNpcStatus !== undefined) npc.status = args.updateNpcStatus;
            npc.lastMentionScene = state.sceneCount;
          }
        }

        // Add clock
        if (args.addClockName) {
          state.clocks.push({
            id: `clock_${state.clocks.length + 1}`,
            name: args.addClockName,
            clockType: args.addClockType || "threat",
            segments: args.addClockSegments || 6,
            filled: 0,
            triggerDescription: args.addClockTrigger || "",
            owner: "world",
          });
        }

        // Advance clock
        if (args.advanceClockName) {
          const clock = state.clocks.find(c => c.name === args.advanceClockName);
          if (clock) clock.filled = Math.min(clock.segments, clock.filled + 1);
        }

        // Remove clock
        if (args.removeClockName) {
          state.clocks = state.clocks.filter(c => c.name !== args.removeClockName);
        }

        // Story arc
        if (args.advanceAct && state.storyBlueprint) {
          state.storyBlueprint.currentAct = Math.min(
            state.storyBlueprint.acts.length,
            state.storyBlueprint.currentAct + 1,
          );
        }
        if (args.storyComplete && state.storyBlueprint) {
          state.storyBlueprint.storyComplete = true;
        }

        // Session log
        if (args.logEntry) {
          state.sessionLog.push({
            scene: state.sceneCount,
            summary: args.logEntry,
            location: state.currentLocation,
          });
          if (state.sessionLog.length > MAX_SESSION_LOG) {
            state.sessionLog = state.sessionLog.slice(-MAX_SESSION_LOG);
          }
        }

        // Crisis check
        if (state.health <= 0 && state.spirit <= 0) {
          state.gameOver = true; state.crisisMode = true;
        } else if (state.health <= 0 || state.spirit <= 0) {
          state.crisisMode = true;
        } else {
          state.crisisMode = false;
        }

        return {
          success: true,
          initialized: state.initialized,
          phase: state.phase,
          settingGenre: state.settingGenre,
          settingTone: state.settingTone,
          settingArchetype: state.settingArchetype,
          settingDescription: state.settingDescription,
          playerName: state.playerName,
          characterConcept: state.characterConcept,
          edge: state.edge, heart: state.heart, iron: state.iron,
          shadow: state.shadow, wits: state.wits,
          health: state.health, spirit: state.spirit, supply: state.supply,
          momentum: state.momentum, maxMomentum: state.maxMomentum,
          currentLocation: state.currentLocation,
          currentSceneContext: state.currentSceneContext,
          timeOfDay: state.timeOfDay,
          chaosFactor: state.chaosFactor,
          crisisMode: state.crisisMode,
          gameOver: state.gameOver,
          sceneCount: state.sceneCount,
          npcs: state.npcs.map(n => ({
            id: n.id, name: n.name, disposition: n.disposition,
            bond: n.bond, agenda: n.agenda, status: n.status,
            description: n.description,
          })),
          clocks: state.clocks.map(c => ({
            id: c.id, name: c.name, clockType: c.clockType,
            segments: c.segments, filled: c.filled,
            triggerDescription: c.triggerDescription,
          })),
          storyBlueprint: state.storyBlueprint ? {
            structureType: state.storyBlueprint.structureType,
            currentAct: state.storyBlueprint.currentAct,
            totalActs: state.storyBlueprint.acts.length,
            centralConflict: state.storyBlueprint.centralConflict,
            thematicThread: state.storyBlueprint.thematicThread,
            storyComplete: state.storyBlueprint.storyComplete,
            currentPhase: state.storyBlueprint.acts[state.storyBlueprint.currentAct - 1]?.phase,
          } : null,
          kidMode: state.kidMode,
          sessionLog: state.sessionLog.slice(-5),
        };
      },
    }),

    save_game: gameTool({
      description: "Save current game to persistent storage.",
      parameters: z.object({
        slot: z.string().optional().describe("Save slot name, defaults to autosave"),
      }),
      execute: async (args, ctx) => {
        const state = ctx.state;
        await ctx.kv.set(`save:${args.slot || "autosave"}`, state);
        return { saved: true, slot: args.slot || "autosave", name: state.playerName, scene: state.sceneCount };
      },
    }),

    load_game: gameTool({
      description: "Load a previously saved game.",
      parameters: z.object({
        slot: z.string().optional().describe("Save slot name, defaults to autosave"),
      }),
      execute: async (args, ctx) => {
        const saved = await ctx.kv.get<GameState>(`save:${args.slot || "autosave"}`);
        if (!saved) return { error: "No save found." };
        Object.assign(ctx.state, saved);
        const state = ctx.state;
        return {
          loaded: true,
          playerName: state.playerName,
          characterConcept: state.characterConcept,
          settingGenre: state.settingGenre,
          sceneCount: state.sceneCount,
          currentLocation: state.currentLocation,
          initialized: state.initialized,
        };
      },
    }),
  },
});
