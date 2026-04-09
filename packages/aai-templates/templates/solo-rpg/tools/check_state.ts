import type { KV } from "../_shared.ts";
import { getGameState } from "../_shared.ts";

export default async function execute(_args: unknown, ctx: { kv: KV }) {
  const s = await getGameState(ctx.kv);
  return {
    initialized: s.initialized,
    phase: s.phase,
    settingGenre: s.settingGenre,
    settingTone: s.settingTone,
    settingArchetype: s.settingArchetype,
    playerName: s.playerName,
    characterConcept: s.characterConcept,
    edge: s.edge,
    heart: s.heart,
    iron: s.iron,
    shadow: s.shadow,
    wits: s.wits,
    health: s.health,
    spirit: s.spirit,
    supply: s.supply,
    momentum: s.momentum,
    maxMomentum: s.maxMomentum,
    sceneCount: s.sceneCount,
    currentLocation: s.currentLocation,
    timeOfDay: s.timeOfDay,
    chaosFactor: s.chaosFactor,
    crisisMode: s.crisisMode,
    gameOver: s.gameOver,
    npcs: s.npcs
      .filter((n) => n.status !== "deceased")
      .map((n) => ({
        id: n.id,
        name: n.name,
        disposition: n.disposition,
        bond: n.bond,
        agenda: n.agenda,
        status: n.status,
      })),
    clocks: s.clocks
      .filter((c) => c.filled < c.segments)
      .map((c) => ({
        name: c.name,
        type: c.clockType,
        filled: c.filled,
        segments: c.segments,
      })),
    storyAct: s.storyBlueprint
      ? {
          current: s.storyBlueprint.currentAct,
          total: s.storyBlueprint.acts.length,
          phase: s.storyBlueprint.acts[s.storyBlueprint.currentAct - 1]?.phase,
          complete: s.storyBlueprint.storyComplete,
        }
      : null,
    kidMode: s.kidMode,
    directorGuidance: s.directorGuidance,
    recentLog: s.sessionLog.slice(-3),
  };
}
