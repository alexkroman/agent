// ── Tuning Constants ─────────────────────────────────────────────────────────
const MAX_ACTIVE_NPCS = 12;
const MAX_SESSION_LOG = 50;

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

// ── Genres, Tones, Archetypes ────────────────────────────────────────────────
const GENRES: Record<string, string> = {
  dark_fantasy: "Dark Fantasy", high_fantasy: "High Fantasy",
  science_fiction: "Sci-Fi", horror_mystery: "Horror / Mystery",
  steampunk: "Steampunk", cyberpunk: "Cyberpunk",
  urban_fantasy: "Urban Fantasy", victorian_crime: "Victorian Crime",
  historical_roman: "Historical / Roman", fairy_tale: "Fairy Tale World",
  slice_of_life_90s: "Slice of Life 1990s", outdoor_survival: "Outdoor Survival",
};

const TONES: Record<string, string> = {
  dark_gritty: "Dark & Gritty", serious_balanced: "Serious but Fair",
  melancholic: "Melancholic", absurd_grotesque: "Absurd & Grotesque",
  slow_burn_horror: "Slow-Burn Horror", cheerful_funny: "Cheerful & Fun",
  romantic: "Romantic", slapstick: "Slapstick", epic_heroic: "Epic & Heroic",
  tarantino: "Tarantino-Style", cozy: "Cozy & Comfy", tragicomic: "Tragicomic",
};

const ARCHETYPES: Record<string, string> = {
  outsider_loner: "Outsider / Loner", investigator: "Investigator / Curious",
  trickster: "Trickster / Charmer", protector: "Protector / Warrior",
  hardboiled: "Hardboiled / Veteran", scholar: "Scholar / Mystic",
  healer: "Healer / Medic", inventor: "Crafter / Inventor",
  artist: "Artist / Bard",
};

// ── Moves ────────────────────────────────────────────────────────────────────
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

// ── Time Phases ──────────────────────────────────────────────────────────────
const TIME_PHASES = [
  "early_morning","morning","midday","afternoon",
  "evening","late_evening","night","deep_night",
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

// ── Disposition System ──────────────────────────────────────────────────────
const DISPOSITIONS = ["hostile","distrustful","neutral","friendly","loyal"] as const;
type Disposition = typeof DISPOSITIONS[number];

// ── NPC Interface ───────────────────────────────────────────────────────────
interface NPC {
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

// ── Clock Interface ─────────────────────────────────────────────────────────
interface Clock {
  id: string;
  name: string;
  clockType: "threat" | "progress" | "scheme";
  segments: number;
  filled: number;
  triggerDescription: string;
  owner: string;
}

// ── Story Blueprint ─────────────────────────────────────────────────────────
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

// ── Session Log Entry ───────────────────────────────────────────────────────
interface SessionLogEntry {
  scene: number;
  summary: string;
  richSummary?: string;
  location: string;
  move?: string;
  result?: string;
}

// ── Game State ──────────────────────────────────────────────────────────────
interface GameState {
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

const defaultState: GameState = {
  initialized: false,
  phase: "genre",
  settingGenre: "", settingTone: "", settingArchetype: "", settingDescription: "",
  playerName: "", characterConcept: "", backstory: "", playerWishes: "", contentLines: "",
  edge: 1, heart: 2, iron: 1, shadow: 1, wits: 2,
  health: 5, spirit: 5, supply: 5,
  momentum: 2, maxMomentum: 10,
  sceneCount: 0, currentLocation: "", currentSceneContext: "", timeOfDay: "",
  locationHistory: [], chaosFactor: 5,
  crisisMode: false, gameOver: false,
  npcs: [], clocks: [],
  storyBlueprint: null, chapterNumber: 1,
  campaignHistory: [], sessionLog: [], narrationHistory: [],
  directorGuidance: {}, kidMode: false,
};

// ── Helpers ─────────────────────────────────────────────────────────────────
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

// ── Dice System ─────────────────────────────────────────────────────────────
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

// ── Chaos Factor ────────────────────────────────────────────────────────────
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

// ── Consequences ────────────────────────────────────────────────────────────
function applyConsequences(
  game: GameState, roll: RollResult, position: string, effect: string, targetNpcId: string | null,
): { consequences: string[]; clockEvents: { clock: string; trigger: string }[] } {
  const consequences: string[] = [];
  const clockEvents: { clock: string; trigger: string }[] = [];
  const target = targetNpcId ? game.npcs.find(n => n.id === targetNpcId) : null;

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
        hostile: "distrustful", distrustful: "neutral",
        neutral: "friendly", friendly: "loyal",
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

// ── Momentum Burn ───────────────────────────────────────────────────────────
function canBurnMomentum(game: GameState, roll: RollResult): string | null {
  if (game.momentum <= 0) return null;
  if (roll.result === "MISS" && game.momentum > roll.c1 && game.momentum > roll.c2) return "STRONG_HIT";
  if (roll.result === "MISS" && (game.momentum > roll.c1 || game.momentum > roll.c2)) return "WEAK_HIT";
  if (roll.result === "WEAK_HIT" && game.momentum > roll.c1 && game.momentum > roll.c2) return "STRONG_HIT";
  return null;
}

// ── Kishotenketsu Probability ───────────────────────────────────────────────
const KISHOTENKETSU_PROB: Record<string, number> = {
  melancholic: 0.5, cozy: 0.4, romantic: 0.35, tragicomic: 0.3,
  slow_burn_horror: 0.25, cheerful_funny: 0.2, absurd_grotesque: 0.2,
};

function chooseStoryStructure(tone: string): "3act" | "kishotenketsu" {
  const prob = KISHOTENKETSU_PROB[tone] ?? 0.1;
  return Math.random() < prob ? "kishotenketsu" : "3act";
}

// ── KV persistence helpers ──────────────────────────────────────────────────
async function autoSave(ctx: ToolContext<GameState>): Promise<void> {
  if (ctx.state.initialized) {
    await ctx.kv.set("save:game", ctx.state);
  }
}

async function lazyLoad(ctx: ToolContext<GameState>): Promise<void> {
  if (!ctx.state.initialized) {
    const saved = await ctx.kv.get<GameState>("save:game");
    if (saved) Object.assign(ctx.state, saved);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// TOOLS
// ═════════════════════════════════════════════════════════════════════════════

export default {
  state: (): GameState => structuredClone(defaultState),

  tools: {
    check_state: {
      description:
        "Returns the full current game state. This is AUTOMATICALLY forced as the first tool call every turn. Use these numbers as ground truth — never guess or remember stats from previous turns.",
      execute: async (_args: Record<string, unknown>, ctx: ToolContext<GameState>) => {
        await lazyLoad(ctx);
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

    setup_character: {
      description:
        "Set up the entire game in one call. Generates stats, initializes state, and marks the game as ready. After this returns, just narrate the opening scene. No need to call update_state — everything is already done.",
      parameters: {
        type: "object" as const,
        properties: {
          genre: { type: "string", description: "Chosen genre code or custom description" },
          tone: { type: "string", description: "Chosen tone code or custom description" },
          archetype: { type: "string", description: "Chosen archetype code or custom description" },
          playerName: { type: "string", description: "Character name" },
          characterConcept: { type: "string", description: "One-line character concept" },
          settingDescription: { type: "string", description: "Two to three sentence setting description" },
          startingLocation: { type: "string", description: "Name of starting location" },
          locationDesc: { type: "string", description: "One sentence description of starting location" },
          timeOfDay: { type: "string", enum: ["early_morning","morning","midday","afternoon","evening","late_evening","night","deep_night"], description: "Starting time of day" },
          openingSituation: { type: "string", description: "One sentence dramatic hook for the opening scene" },
          npc1Name: { type: "string", description: "First NPC name" },
          npc1Desc: { type: "string", description: "First NPC one-line description" },
          npc1Disposition: { type: "string", enum: ["hostile","distrustful","neutral","friendly","loyal"], description: "First NPC disposition" },
          npc1Agenda: { type: "string", description: "First NPC agenda" },
          threatClockName: { type: "string", description: "Name of initial threat clock" },
          threatClockDesc: { type: "string", description: "What happens when the threat clock fills" },
          threatClockSegments: { type: "number", description: "Segments for threat clock, default 6" },
          backstory: { type: "string" },
          wishes: { type: "string" },
          contentLines: { type: "string" },
          kidMode: { type: "boolean" },
        },
        required: ["genre", "tone", "archetype", "playerName", "characterConcept", "settingDescription", "startingLocation", "locationDesc", "timeOfDay", "openingSituation", "npc1Name", "npc1Desc", "npc1Disposition", "npc1Agenda", "threatClockName", "threatClockDesc"],
      },
      execute: async (args: Record<string, unknown>, ctx: ToolContext<GameState>) => {
        const state = ctx.state;
        const genre = args.genre as string;
        const tone = args.tone as string;
        const archetype = args.archetype as string;

        state.settingGenre = genre;
        state.settingTone = tone;
        state.settingArchetype = archetype;
        state.playerName = args.playerName as string;
        state.characterConcept = args.characterConcept as string;
        state.settingDescription = args.settingDescription as string;
        state.backstory = (args.backstory as string) || "";
        state.playerWishes = (args.wishes as string) || "";
        state.contentLines = (args.contentLines as string) || "";
        state.kidMode = (args.kidMode as boolean) || false;

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
        const biasIdx = archetypeBias[archetype] ?? Math.floor(Math.random() * 5);
        const highIdx = statValues.indexOf(3);
        if (highIdx !== biasIdx) {
          [statValues[highIdx], statValues[biasIdx]] = [statValues[biasIdx]!, statValues[highIdx]!];
        }
        state.edge = statValues[0]!;
        state.heart = statValues[1]!;
        state.iron = statValues[2]!;
        state.shadow = statValues[3]!;
        state.wits = statValues[4]!;

        state.currentLocation = args.startingLocation as string;
        state.currentSceneContext = args.locationDesc as string;
        state.timeOfDay = args.timeOfDay as string;

        const npc1Disposition = args.npc1Disposition as Disposition;
        state.npcs.push({
          id: "npc_1",
          name: args.npc1Name as string,
          description: args.npc1Desc as string,
          disposition: npc1Disposition,
          bond: npc1Disposition === "friendly" ? 1 : npc1Disposition === "loyal" ? 2 : 0,
          agenda: args.npc1Agenda as string,
          instinct: "", status: "active", aliases: [], lastMentionScene: 0,
        });

        const threatClockSegments = (args.threatClockSegments as number) || 6;
        state.clocks.push({
          id: "clock_1",
          name: args.threatClockName as string,
          clockType: "threat",
          segments: threatClockSegments,
          filled: 0,
          triggerDescription: args.threatClockDesc as string,
          owner: "world",
        });

        const structure = chooseStoryStructure(tone);
        state.storyBlueprint = {
          structureType: structure,
          centralConflict: args.openingSituation as string,
          antagonistForce: "", thematicThread: "",
          acts: structure === "3act"
            ? [
              { phase: "setup", title: "The Hook", goal: "Establish the world and the conflict", mood: tone, transitionTrigger: "Player engages with the central conflict" },
              { phase: "confrontation", title: "Rising Stakes", goal: "Escalate tension and complications", mood: tone, transitionTrigger: "A major setback or revelation" },
              { phase: "climax", title: "The Reckoning", goal: "Resolve the central conflict", mood: tone, transitionTrigger: "Story reaches its conclusion" },
            ]
            : [
              { phase: "ki_introduction", title: "Ki", goal: "Introduce the world and characters", mood: tone, transitionTrigger: "World is established" },
              { phase: "sho_development", title: "Sho", goal: "Develop relationships and deepen the world", mood: tone, transitionTrigger: "Relationships are tested" },
              { phase: "ten_twist", title: "Ten", goal: "An unexpected twist changes everything", mood: tone, transitionTrigger: "The twist lands" },
              { phase: "ketsu_resolution", title: "Ketsu", goal: "Resolve and reflect", mood: tone, transitionTrigger: "Story reaches its conclusion" },
            ],
          revelations: [], possibleEndings: [], currentAct: 1, storyComplete: false,
        };

        state.initialized = true;
        state.phase = "playing";
        state.sceneCount = 1;

        await autoSave(ctx);

        return {
          success: true, initialized: true,
          playerName: state.playerName, characterConcept: state.characterConcept,
          settingGenre: GENRES[genre] || genre,
          settingTone: TONES[tone] || tone,
          settingArchetype: ARCHETYPES[archetype] || archetype,
          settingDescription: state.settingDescription,
          stats: { edge: state.edge, heart: state.heart, iron: state.iron, shadow: state.shadow, wits: state.wits },
          health: 5, spirit: 5, supply: 5, momentum: 2,
          currentLocation: state.currentLocation,
          currentSceneContext: state.currentSceneContext,
          timeOfDay: state.timeOfDay, chaosFactor: 5,
          npcs: state.npcs.map(n => ({ id: n.id, name: n.name, disposition: n.disposition, bond: n.bond, agenda: n.agenda, status: n.status, description: n.description })),
          clocks: state.clocks.map(c => ({ id: c.id, name: c.name, clockType: c.clockType, segments: c.segments, filled: c.filled, triggerDescription: c.triggerDescription })),
          storyBlueprint: { structureType: state.storyBlueprint.structureType, currentAct: 1, totalActs: state.storyBlueprint.acts.length, centralConflict: state.storyBlueprint.centralConflict, thematicThread: "", storyComplete: false, currentPhase: state.storyBlueprint.acts[0]!.phase },
          openingSituation: args.openingSituation as string,
          creativitySeed: creativitySeed(),
          phase: "playing", sceneCount: 1, kidMode: state.kidMode,
        };
      },
    },

    action_roll: {
      description:
        "Core mechanic. Roll 2d6 + stat (capped at 10) vs 2d10 challenge dice. Also applies consequences (health/spirit/supply/momentum changes, clock advancement) based on move type, position, and result. Call for ANY risky action.",
      parameters: {
        type: "object" as const,
        properties: {
          move: { type: "string", enum: [...MOVES], description: "Which move the player is making" },
          stat: { type: "string", enum: ["edge","heart","iron","shadow","wits"], description: "Which stat to roll" },
          position: { type: "string", enum: ["controlled","risky","desperate"], description: "How dangerous the situation is" },
          effect: { type: "string", enum: ["limited","standard","great"], description: "What can realistically be achieved" },
          purpose: { type: "string", description: "What the character is attempting" },
          targetNpcId: { type: "string", description: "Target NPC id for social moves" },
        },
        required: ["move", "stat", "position", "effect", "purpose"],
      },
      execute: async (args: Record<string, unknown>, ctx: ToolContext<GameState>) => {
        const move = args.move as string;
        const stat = args.stat as string;
        const position = args.position as string;
        const effect = args.effect as string;
        const purpose = args.purpose as string;
        const targetNpcId = args.targetNpcId as string | undefined;

        const state = ctx.state;
        const statValue = state[stat as keyof GameState] as number;
        const roll = rollAction(stat, statValue, move);

        const { consequences, clockEvents } = applyConsequences(
          state, roll, position, effect, targetNpcId || null,
        );

        updateChaosFactor(state, roll.result);
        const interrupt = checkChaosInterrupt(state);
        state.sceneCount++;

        const burnTarget = canBurnMomentum(state, roll);

        const resultLabels: Record<string, string> = {
          STRONG_HIT: "Strong Hit", WEAK_HIT: "Weak Hit", MISS: "Miss",
        };

        await autoSave(ctx);

        return {
          purpose,
          move: MOVE_LABELS[move] || move,
          moveCode: move,
          stat, statValue,
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
          position, effect, consequences, clockEvents,
          chaosInterrupt: interrupt,
          currentHealth: state.health, currentSpirit: state.spirit,
          currentSupply: state.supply, currentMomentum: state.momentum,
          chaosFactor: state.chaosFactor,
          crisisMode: state.crisisMode, gameOver: state.gameOver,
          sceneCount: state.sceneCount,
          canBurnMomentum: !!burnTarget,
          burnWouldYield: burnTarget ? resultLabels[burnTarget] : undefined,
        };
      },
    },

    burn_momentum: {
      description:
        "Burn momentum to upgrade a roll result. Only valid when current momentum beats both challenge dice for the roll being upgraded. Resets momentum to +2.",
      parameters: {
        type: "object" as const,
        properties: {
          c1: { type: "number", description: "First challenge die from the roll" },
          c2: { type: "number", description: "Second challenge die from the roll" },
        },
        required: ["c1", "c2"],
      },
      execute: async (args: Record<string, unknown>, ctx: ToolContext<GameState>) => {
        const c1 = args.c1 as number;
        const c2 = args.c2 as number;
        const state = ctx.state;
        const mom = state.momentum;
        if (mom <= 0) return { error: "Momentum is 0 or negative. Cannot burn." };

        let newResult: string;
        if (mom > c1 && mom > c2) newResult = "STRONG_HIT";
        else if (mom > c1 || mom > c2) newResult = "WEAK_HIT";
        else return { error: "Momentum not high enough to improve the result." };

        const previousMomentum = mom;
        state.momentum = 2;

        const labels: Record<string, string> = { STRONG_HIT: "Strong Hit", WEAK_HIT: "Weak Hit" };

        await autoSave(ctx);

        return {
          burned: true, previousMomentum, newMomentum: 2,
          newResult: labels[newResult], newResultCode: newResult,
          challengeDice: [c1, c2],
        };
      },
    },

    oracle: {
      description:
        "Consult the oracle for narrative inspiration. Generates random prompts from thematic tables.",
      parameters: {
        type: "object" as const,
        properties: {
          type: { type: "string", enum: ["action_theme","npc_reaction","scene_twist","yes_no","chaos_check"], description: "Type of oracle consultation" },
        },
        required: ["type"],
      },
      execute: (args: Record<string, unknown>, ctx: ToolContext<GameState>) => {
        const type = args.type as string;
        const state = ctx.state;

        if (type === "yes_no") {
          const roll = d(6);
          const answer = roll <= 2 ? "No" : roll <= 4 ? "Yes, but with a complication" : "Yes";
          return { type: "yes_no", roll, answer };
        }

        if (type === "chaos_check") {
          const interrupt = checkChaosInterrupt(state);
          return { type: "chaos_check", chaosFactor: state.chaosFactor, interrupted: !!interrupt, interruptType: interrupt };
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
        return { type: "action_theme", action: pick(actions), theme: pick(themes), seed: creativitySeed() };
      },
    },

    update_state: {
      description:
        "Lightweight state sync for during gameplay. Handles location changes, NPC additions, clock additions, time changes, and session log entries. Resource changes (health/spirit/supply/momentum) are auto-applied by action_roll — only use those fields here for manual adjustments like resting or trading. Pass only what changed.",
      parameters: {
        type: "object" as const,
        properties: {
          location: { type: "string", description: "New location name" },
          locationDesc: { type: "string", description: "Short location description" },
          timeOfDay: { type: "string", description: "New time of day" },
          health: { type: "number" },
          spirit: { type: "number" },
          supply: { type: "number" },
          momentum: { type: "number" },
          addNpcName: { type: "string", description: "New NPC name" },
          addNpcDesc: { type: "string", description: "New NPC one-line description" },
          addNpcDisposition: { type: "string", enum: ["hostile","distrustful","neutral","friendly","loyal"], description: "New NPC disposition" },
          addNpcAgenda: { type: "string", description: "New NPC agenda" },
          updateNpcId: { type: "string", description: "NPC id to update" },
          updateNpcDisposition: { type: "string", enum: ["hostile","distrustful","neutral","friendly","loyal"] },
          updateNpcBond: { type: "number" },
          updateNpcStatus: { type: "string", enum: ["active","background","deceased"] },
          addClockName: { type: "string", description: "New clock name" },
          addClockType: { type: "string", enum: ["threat","progress","scheme"] },
          addClockSegments: { type: "number", description: "Number of segments, default 6" },
          addClockTrigger: { type: "string", description: "What happens when clock fills" },
          advanceClockName: { type: "string", description: "Clock name to advance by 1" },
          removeClockName: { type: "string", description: "Clock name to remove" },
          advanceAct: { type: "boolean", description: "Move to next story act" },
          storyComplete: { type: "boolean", description: "Mark story as complete" },
          logEntry: { type: "string", description: "Short log entry for this scene" },
        },
        required: [],
      },
      execute: async (args: Record<string, unknown>, ctx: ToolContext<GameState>) => {
        const state = ctx.state;

        if (args.health !== undefined) state.health = Math.max(0, Math.min(5, args.health as number));
        if (args.spirit !== undefined) state.spirit = Math.max(0, Math.min(5, args.spirit as number));
        if (args.supply !== undefined) state.supply = Math.max(0, Math.min(5, args.supply as number));
        if (args.momentum !== undefined) state.momentum = Math.max(-6, Math.min(state.maxMomentum, args.momentum as number));

        if (args.location !== undefined) {
          const loc = args.location as string;
          if (state.currentLocation && state.currentLocation !== loc) {
            state.locationHistory.push(state.currentLocation);
            if (state.locationHistory.length > 5) state.locationHistory = state.locationHistory.slice(-5);
          }
          state.currentLocation = loc;
        }
        if (args.locationDesc !== undefined) state.currentSceneContext = args.locationDesc as string;
        if (args.timeOfDay !== undefined) state.timeOfDay = args.timeOfDay as string;

        if (args.addNpcName) {
          const id = nextNpcId(state.npcs);
          const disposition = (args.addNpcDisposition as Disposition) || "neutral";
          state.npcs.push({
            id, name: args.addNpcName as string,
            description: (args.addNpcDesc as string) || "",
            disposition,
            bond: disposition === "friendly" ? 1 : disposition === "loyal" ? 2 : 0,
            agenda: (args.addNpcAgenda as string) || "", instinct: "",
            status: "active", aliases: [], lastMentionScene: state.sceneCount,
          });
        }

        if (args.updateNpcId) {
          const npc = state.npcs.find(n => n.id === (args.updateNpcId as string));
          if (npc) {
            if (args.updateNpcDisposition !== undefined) npc.disposition = args.updateNpcDisposition as Disposition;
            if (args.updateNpcBond !== undefined) npc.bond = args.updateNpcBond as number;
            if (args.updateNpcStatus !== undefined) npc.status = args.updateNpcStatus as NPC["status"];
            npc.lastMentionScene = state.sceneCount;
          }
        }

        if (args.addClockName) {
          state.clocks.push({
            id: `clock_${state.clocks.length + 1}`,
            name: args.addClockName as string,
            clockType: (args.addClockType as Clock["clockType"]) || "threat",
            segments: (args.addClockSegments as number) || 6,
            filled: 0,
            triggerDescription: (args.addClockTrigger as string) || "",
            owner: "world",
          });
        }

        if (args.advanceClockName) {
          const clock = state.clocks.find(c => c.name === (args.advanceClockName as string));
          if (clock) clock.filled = Math.min(clock.segments, clock.filled + 1);
        }

        if (args.removeClockName) {
          state.clocks = state.clocks.filter(c => c.name !== (args.removeClockName as string));
        }

        if (args.advanceAct && state.storyBlueprint) {
          state.storyBlueprint.currentAct = Math.min(
            state.storyBlueprint.acts.length,
            state.storyBlueprint.currentAct + 1,
          );
        }
        if (args.storyComplete && state.storyBlueprint) {
          state.storyBlueprint.storyComplete = true;
        }

        if (args.logEntry) {
          state.sessionLog.push({
            scene: state.sceneCount,
            summary: args.logEntry as string,
            location: state.currentLocation,
          });
          if (state.sessionLog.length > MAX_SESSION_LOG) {
            state.sessionLog = state.sessionLog.slice(-MAX_SESSION_LOG);
          }
        }

        if (state.health <= 0 && state.spirit <= 0) {
          state.gameOver = true; state.crisisMode = true;
        } else if (state.health <= 0 || state.spirit <= 0) {
          state.crisisMode = true;
        } else {
          state.crisisMode = false;
        }

        await autoSave(ctx);

        return {
          success: true, initialized: state.initialized, phase: state.phase,
          settingGenre: state.settingGenre, settingTone: state.settingTone,
          settingArchetype: state.settingArchetype, settingDescription: state.settingDescription,
          playerName: state.playerName, characterConcept: state.characterConcept,
          edge: state.edge, heart: state.heart, iron: state.iron,
          shadow: state.shadow, wits: state.wits,
          health: state.health, spirit: state.spirit, supply: state.supply,
          momentum: state.momentum, maxMomentum: state.maxMomentum,
          currentLocation: state.currentLocation,
          currentSceneContext: state.currentSceneContext,
          timeOfDay: state.timeOfDay, chaosFactor: state.chaosFactor,
          crisisMode: state.crisisMode, gameOver: state.gameOver,
          sceneCount: state.sceneCount,
          npcs: state.npcs.map(n => ({
            id: n.id, name: n.name, disposition: n.disposition,
            bond: n.bond, agenda: n.agenda, status: n.status, description: n.description,
          })),
          clocks: state.clocks.map(c => ({
            id: c.id, name: c.name, clockType: c.clockType,
            segments: c.segments, filled: c.filled, triggerDescription: c.triggerDescription,
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
    },

    save_game: {
      description: "Save current game to persistent storage.",
      parameters: {
        type: "object" as const,
        properties: {
          slot: { type: "string", description: "Save slot name, defaults to autosave" },
        },
        required: [],
      },
      execute: async (args: Record<string, unknown>, ctx: ToolContext<GameState>) => {
        const state = ctx.state;
        const slot = (args.slot as string) || "autosave";
        await ctx.kv.set(`save:${slot}`, state);
        return { saved: true, slot, name: state.playerName, scene: state.sceneCount };
      },
    },

    load_game: {
      description: "Load a previously saved game.",
      parameters: {
        type: "object" as const,
        properties: {
          slot: { type: "string", description: "Save slot name, defaults to autosave" },
        },
        required: [],
      },
      execute: async (args: Record<string, unknown>, ctx: ToolContext<GameState>) => {
        const slot = (args.slot as string) || "autosave";
        const saved = await ctx.kv.get<GameState>(`save:${slot}`);
        if (!saved) return { error: "No save found." };
        Object.assign(ctx.state, saved);
        const state = ctx.state;
        return {
          loaded: true, playerName: state.playerName,
          characterConcept: state.characterConcept,
          settingGenre: state.settingGenre, sceneCount: state.sceneCount,
          currentLocation: state.currentLocation, initialized: state.initialized,
        };
      },
    },
  },
} satisfies AgentTools<GameState>;
