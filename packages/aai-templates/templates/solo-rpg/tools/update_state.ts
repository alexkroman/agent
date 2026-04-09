import type { Disposition, KV } from "../_shared.ts";
import { getGameState, MAX_SESSION_LOG, nextNpcId, saveGameState } from "../_shared.ts";

export default async function execute(
  args: {
    location?: string;
    locationDesc?: string;
    timeOfDay?: string;
    health?: number;
    spirit?: number;
    supply?: number;
    momentum?: number;
    addNpcName?: string;
    addNpcDesc?: string;
    addNpcDisposition?: Disposition;
    addNpcAgenda?: string;
    updateNpcId?: string;
    updateNpcDisposition?: Disposition;
    updateNpcBond?: number;
    updateNpcStatus?: "active" | "background" | "deceased";
    addClockName?: string;
    addClockType?: "threat" | "progress" | "scheme";
    addClockSegments?: number;
    addClockTrigger?: string;
    advanceClockName?: string;
    removeClockName?: string;
    advanceAct?: boolean;
    storyComplete?: boolean;
    logEntry?: string;
  },
  ctx: { kv: KV },
) {
  const state = await getGameState(ctx.kv);

  // Resources
  if (args.health !== undefined) state.health = Math.max(0, Math.min(5, args.health));
  if (args.spirit !== undefined) state.spirit = Math.max(0, Math.min(5, args.spirit));
  if (args.supply !== undefined) state.supply = Math.max(0, Math.min(5, args.supply));
  if (args.momentum !== undefined)
    state.momentum = Math.max(-6, Math.min(state.maxMomentum, args.momentum));

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
      id,
      name: args.addNpcName,
      description: args.addNpcDesc ?? "",
      disposition: args.addNpcDisposition ?? "neutral",
      bond: args.addNpcDisposition === "friendly" ? 1 : args.addNpcDisposition === "loyal" ? 2 : 0,
      agenda: args.addNpcAgenda ?? "",
      instinct: "",
      status: "active",
      aliases: [],
      lastMentionScene: state.sceneCount,
    });
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
  if (state.health <= 0 && state.spirit <= 0) {
    state.gameOver = true;
    state.crisisMode = true;
  } else if (state.health <= 0 || state.spirit <= 0) {
    state.crisisMode = true;
  } else {
    state.crisisMode = false;
  }

  await saveGameState(ctx.kv, state);

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
}
