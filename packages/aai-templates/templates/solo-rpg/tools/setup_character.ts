import { tool } from "@alexkroman1/aai";
import { z } from "zod";
import {
  ARCHETYPES,
  chooseStoryStructure,
  creativitySeed,
  DEFAULT_CLOCK_SEGMENTS,
  DEFAULT_STATE,
  DISPOSITIONS,
  GENRES,
  gameSlot,
  MAX_CLOCK_SEGMENTS,
  MIN_CLOCK_SEGMENTS,
  makeNpc,
  shuffle,
  stateSummary,
  storyFlow,
  TIME_PHASES,
  TONES,
} from "../shared.ts";

/**
 * **Not a `storyFlow.tool`, deliberately.** Setting up is legal in every state —
 * a player may start over at any point, an ended story included — so a `when`
 * listing all of them would be a gate that gates nothing. It drives the flow
 * itself, which is what `flow.reset` and `flow.send` are public for, and reports
 * the position it landed in so the narrator reads what the opening turn expects.
 *
 * **`reset` before `send`, because a restart is not a transition.** This body
 * replaces the campaign with a pristine `DEFAULT_STATE`; resetting the flow is
 * the same statement on the other side, and it is what makes starting over work
 * from `gameOver` — a final state delivers no events, so a `SETUP` transition
 * out of it would be dead config.
 */
export default tool({
  description:
    "Set up the entire game in one call. Starts a completely fresh game (any previous unsaved game is replaced), generates stats, initializes state, and marks the game as ready. After this returns, just narrate the opening scene. No need to call update_state — everything is already done.",
  inputSchema: z.object({
    genre: z.string().max(100).describe("Chosen genre code or custom description"),
    tone: z.string().max(100).describe("Chosen tone code or custom description"),
    archetype: z.string().max(100).describe("Chosen archetype code or custom description"),
    playerName: z.string().max(100).describe("Character name"),
    characterConcept: z.string().max(300).describe("One-line character concept"),
    settingDescription: z.string().max(1000).describe("Two to three sentence setting description"),
    startingLocation: z.string().max(200).describe("Name of starting location"),
    locationDesc: z.string().max(500).describe("One sentence description of starting location"),
    timeOfDay: z.enum(TIME_PHASES).describe("Starting time of day"),
    openingSituation: z
      .string()
      .max(500)
      .describe("One sentence dramatic hook for the opening scene"),
    npc1Name: z.string().max(100).describe("First NPC name"),
    npc1Desc: z.string().max(300).describe("First NPC one-line description"),
    npc1Disposition: z.enum(DISPOSITIONS).describe("First NPC disposition"),
    npc1Agenda: z.string().max(300).describe("First NPC agenda"),
    threatClockName: z.string().max(100).describe("Name of initial threat clock"),
    threatClockDesc: z.string().max(300).describe("What happens when the threat clock fills"),
    threatClockSegments: z
      .number()
      .int()
      .min(MIN_CLOCK_SEGMENTS)
      .max(MAX_CLOCK_SEGMENTS)
      .describe(`Segments for threat clock, default ${DEFAULT_CLOCK_SEGMENTS}`)
      .optional(),
    backstory: z.string().max(2000).optional(),
    wishes: z.string().max(1000).optional(),
    contentLines: z.string().max(1000).optional(),
    kidMode: z.boolean().optional(),
  }),
  async execute(args, ctx) {
    // Always start from a pristine state — re-running setup begins a new
    // story instead of layering NPCs/clocks onto a stale one.
    const state = structuredClone(DEFAULT_STATE);

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
    const statValues = shuffle([3, 2, 2, 1, 1]);
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
    state.npcs.push(
      makeNpc({
        id: "npc_1",
        name: args.npc1Name,
        description: args.npc1Desc,
        disposition: args.npc1Disposition,
        agenda: args.npc1Agenda,
      }),
    );

    // Add threat clock
    state.clocks.push({
      id: "clock_1",
      name: args.threatClockName,
      clockType: "threat",
      segments: args.threatClockSegments ?? DEFAULT_CLOCK_SEGMENTS,
      filled: 0,
      triggerDescription: args.threatClockDesc,
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
      currentAct: 1,
      storyComplete: false,
    };

    // Mark initialized. `initialized` is the CLIENT's render flag; the flow is
    // what gates the tools, and `SETUP` is what puts it in `playing` — so the
    // roll tools become available in the same call that gives them stats to
    // roll against.
    state.initialized = true;
    state.sceneCount = 1;

    // `initialized` is what `playing` MEANS, so this write is the whole
    // transition — and because a fresh `state` carries `gameOver: false` and
    // `lastRoll: null`, starting over from an ending needs no reset either.
    gameSlot.set(ctx, state);
    const at = storyFlow.position(ctx);

    return {
      success: true,
      // Human-readable labels when a known code was used
      genreLabel: GENRES[args.genre as keyof typeof GENRES] || args.genre,
      toneLabel: TONES[args.tone as keyof typeof TONES] || args.tone,
      archetypeLabel: ARCHETYPES[args.archetype as keyof typeof ARCHETYPES] || args.archetype,
      openingSituation: args.openingSituation,
      creativitySeed: creativitySeed(),
      at: at.state,
      next: at.instruction,
      // The real saved state — never hardcoded values
      ...stateSummary(state),
    };
  },
});
