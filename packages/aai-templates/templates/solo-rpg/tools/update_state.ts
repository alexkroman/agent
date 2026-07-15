import { tool } from "@alexkroman1/aai";
import { z } from "zod";
import {
  clockSummary,
  DISPOSITIONS,
  getGameState,
  MAX_RESOURCE,
  MAX_SESSION_LOG,
  MIN_MOMENTUM,
  makeNpc,
  nextNpcId,
  npcSummary,
  saveGameState,
  updateCrisisFlags,
} from "../shared.ts";

export const updateState = tool({
  description:
    "Lightweight state sync for during gameplay. Handles location changes, NPC additions, clock additions, time changes, and session log entries. Resource changes (health/spirit/supply/momentum) are auto-applied by action_roll — only use those fields here for manual adjustments like resting or trading. Pass only what changed.",
  parameters: z.object({
    location: z.string().describe("New location name").optional(),
    locationDesc: z.string().describe("Short location description").optional(),
    timeOfDay: z.string().describe("New time of day").optional(),
    health: z.number().optional(),
    spirit: z.number().optional(),
    supply: z.number().optional(),
    momentum: z.number().optional(),
    addNpcName: z.string().describe("New NPC name").optional(),
    addNpcDesc: z.string().describe("New NPC one-line description").optional(),
    addNpcDisposition: z.enum(DISPOSITIONS).describe("New NPC disposition").optional(),
    addNpcAgenda: z.string().describe("New NPC agenda").optional(),
    updateNpcId: z.string().describe("NPC id to update").optional(),
    updateNpcDisposition: z.enum(DISPOSITIONS).optional(),
    updateNpcBond: z.number().optional(),
    updateNpcStatus: z.enum(["active", "background", "deceased"]).optional(),
    addClockName: z.string().describe("New clock name").optional(),
    addClockType: z.enum(["threat", "progress", "scheme"]).optional(),
    addClockSegments: z.number().describe("Number of segments, default 6").optional(),
    addClockTrigger: z.string().describe("What happens when clock fills").optional(),
    advanceClockName: z.string().describe("Clock name to advance by 1").optional(),
    removeClockName: z.string().describe("Clock name to remove").optional(),
    advanceAct: z.boolean().describe("Move to next story act").optional(),
    storyComplete: z.boolean().describe("Mark story as complete").optional(),
    logEntry: z.string().describe("Short log entry for this scene").optional(),
  }),
  async execute(args, ctx) {
    const state = await getGameState(ctx.kv);

    // Resources
    if (args.health !== undefined) state.health = Math.max(0, Math.min(MAX_RESOURCE, args.health));
    if (args.spirit !== undefined) state.spirit = Math.max(0, Math.min(MAX_RESOURCE, args.spirit));
    if (args.supply !== undefined) state.supply = Math.max(0, Math.min(MAX_RESOURCE, args.supply));
    if (args.momentum !== undefined)
      state.momentum = Math.max(MIN_MOMENTUM, Math.min(state.maxMomentum, args.momentum));

    // Location
    if (args.location !== undefined) {
      if (state.currentLocation && state.currentLocation !== args.location) {
        state.locationHistory.push(state.currentLocation);
        if (state.locationHistory.length > 5)
          state.locationHistory = state.locationHistory.slice(-5);
      }
      state.currentLocation = args.location;
    }
    if (args.locationDesc !== undefined) state.currentSceneContext = args.locationDesc;
    if (args.timeOfDay !== undefined) state.timeOfDay = args.timeOfDay;

    // Add NPC
    if (args.addNpcName) {
      state.npcs.push(
        makeNpc({
          id: nextNpcId(state.npcs),
          name: args.addNpcName,
          description: args.addNpcDesc,
          disposition: args.addNpcDisposition,
          agenda: args.addNpcAgenda,
          lastMentionScene: state.sceneCount,
        }),
      );
    }

    // Update NPC
    if (args.updateNpcId) {
      const npc = state.npcs.find((n) => n.id === args.updateNpcId);
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
        clockType: args.addClockType ?? "threat",
        segments: args.addClockSegments ?? 6,
        filled: 0,
        triggerDescription: args.addClockTrigger ?? "",
        owner: "world",
      });
    }

    // Advance clock
    if (args.advanceClockName) {
      const clock = state.clocks.find((c) => c.name === args.advanceClockName);
      if (clock) clock.filled = Math.min(clock.segments, clock.filled + 1);
    }

    // Remove clock
    if (args.removeClockName) {
      state.clocks = state.clocks.filter((c) => c.name !== args.removeClockName);
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
    updateCrisisFlags(state);

    await saveGameState(ctx.kv, state);
    ctx.send("game_state", state);

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
      currentLocation: state.currentLocation,
      currentSceneContext: state.currentSceneContext,
      timeOfDay: state.timeOfDay,
      chaosFactor: state.chaosFactor,
      crisisMode: state.crisisMode,
      gameOver: state.gameOver,
      sceneCount: state.sceneCount,
      npcs: state.npcs.map(npcSummary),
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
      kidMode: state.kidMode,
      sessionLog: state.sessionLog.slice(-5),
    };
  },
});
