import type { Disposition, KV } from "../_shared.ts";
import {
  ARCHETYPES,
  chooseStoryStructure,
  creativitySeed,
  GENRES,
  getGameState,
  saveGameState,
  TONES,
} from "../_shared.ts";

export default async function execute(
  args: {
    genre: string;
    tone: string;
    archetype: string;
    playerName: string;
    characterConcept: string;
    settingDescription: string;
    startingLocation: string;
    locationDesc: string;
    timeOfDay: string;
    openingSituation: string;
    npc1Name: string;
    npc1Desc: string;
    npc1Disposition: Disposition;
    npc1Agenda: string;
    threatClockName: string;
    threatClockDesc: string;
    threatClockSegments?: number;
    backstory?: string;
    wishes?: string;
    contentLines?: string;
    kidMode?: boolean;
  },
  ctx: { kv: KV },
) {
  const state = await getGameState(ctx.kv);

  // Store creation choices
  state.settingGenre = args.genre;
  state.settingTone = args.tone;
  state.settingArchetype = args.archetype;
  state.playerName = args.playerName;
  state.characterConcept = args.characterConcept;
  state.settingDescription = args.settingDescription;
  state.backstory = args.backstory ?? "";
  state.playerWishes = args.wishes ?? "";
  state.contentLines = args.contentLines ?? "";
  state.kidMode = args.kidMode ?? false;

  // Generate stats: one at 3, two at 2, two at 1 (total = 7)
  const statValues = [3, 2, 2, 1, 1];
  for (let i = statValues.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [statValues[i], statValues[j]] = [statValues[j]!, statValues[i]!];
  }
  const archetypeBias: Record<string, number> = {
    outsider_loner: 0,
    investigator: 4,
    trickster: 3,
    protector: 2,
    hardboiled: 2,
    scholar: 4,
    healer: 1,
    inventor: 4,
    artist: 1,
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
    segments: args.threatClockSegments ?? 6,
    filled: 0,
    triggerDescription: args.threatClockDesc,
    owner: "world",
  });

  // Story blueprint
  const structure = chooseStoryStructure(args.tone);
  state.storyBlueprint = {
    structureType: structure,
    centralConflict: args.openingSituation,
    antagonistForce: "",
    thematicThread: "",
    acts:
      structure === "3act"
        ? [
            {
              phase: "setup",
              title: "The Hook",
              goal: "Establish the world and the conflict",
              mood: args.tone,
              transitionTrigger: "Player engages with the central conflict",
            },
            {
              phase: "confrontation",
              title: "Rising Stakes",
              goal: "Escalate tension and complications",
              mood: args.tone,
              transitionTrigger: "A major setback or revelation",
            },
            {
              phase: "climax",
              title: "The Reckoning",
              goal: "Resolve the central conflict",
              mood: args.tone,
              transitionTrigger: "Story reaches its conclusion",
            },
          ]
        : [
            {
              phase: "ki_introduction",
              title: "Ki",
              goal: "Introduce the world and characters",
              mood: args.tone,
              transitionTrigger: "World is established",
            },
            {
              phase: "sho_development",
              title: "Sho",
              goal: "Develop relationships and deepen the world",
              mood: args.tone,
              transitionTrigger: "Relationships are tested",
            },
            {
              phase: "ten_twist",
              title: "Ten",
              goal: "An unexpected twist changes everything",
              mood: args.tone,
              transitionTrigger: "The twist lands",
            },
            {
              phase: "ketsu_resolution",
              title: "Ketsu",
              goal: "Resolve and reflect",
              mood: args.tone,
              transitionTrigger: "Story reaches its conclusion",
            },
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

  await saveGameState(ctx.kv, state);

  return {
    success: true,
    initialized: true,
    playerName: state.playerName,
    characterConcept: state.characterConcept,
    settingGenre: GENRES[args.genre as keyof typeof GENRES] || args.genre,
    settingTone: TONES[args.tone as keyof typeof TONES] || args.tone,
    settingArchetype: ARCHETYPES[args.archetype as keyof typeof ARCHETYPES] || args.archetype,
    settingDescription: state.settingDescription,
    stats: {
      edge: state.edge,
      heart: state.heart,
      iron: state.iron,
      shadow: state.shadow,
      wits: state.wits,
    },
    health: 5,
    spirit: 5,
    supply: 5,
    momentum: 2,
    currentLocation: state.currentLocation,
    currentSceneContext: state.currentSceneContext,
    timeOfDay: state.timeOfDay,
    chaosFactor: 5,
    npcs: state.npcs.map((n) => ({
      id: n.id,
      name: n.name,
      disposition: n.disposition,
      bond: n.bond,
      agenda: n.agenda,
      status: n.status,
      description: n.description,
    })),
    clocks: state.clocks.map((c) => ({
      id: c.id,
      name: c.name,
      clockType: c.clockType,
      segments: c.segments,
      filled: c.filled,
      triggerDescription: c.triggerDescription,
    })),
    storyBlueprint: {
      structureType: state.storyBlueprint.structureType,
      currentAct: 1,
      totalActs: state.storyBlueprint.acts.length,
      centralConflict: state.storyBlueprint.centralConflict,
      thematicThread: "",
      storyComplete: false,
      currentPhase: state.storyBlueprint.acts[0]?.phase,
    },
    openingSituation: args.openingSituation,
    creativitySeed: creativitySeed(),
    phase: "playing",
    sceneCount: 1,
    kidMode: state.kidMode,
  };
}
