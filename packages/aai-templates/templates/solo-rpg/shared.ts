import type { ToolResultMap } from "aai-cli/types";

// ── Shared types between agent.ts and client.tsx ────────────────────────

export type Disposition = "hostile" | "distrustful" | "neutral" | "friendly" | "loyal";

export interface NPC {
  id: string;
  name: string;
  description: string;
  disposition: Disposition;
  bond: number;
  agenda: string;
  status: "active" | "background" | "deceased";
}

export interface ClockData {
  id: string;
  name: string;
  clockType: "threat" | "progress" | "scheme";
  segments: number;
  filled: number;
  triggerDescription: string;
}

export interface StoryInfo {
  structureType: string;
  currentAct: number;
  totalActs: number;
  centralConflict: string;
  thematicThread: string;
  storyComplete: boolean;
  currentPhase: string;
}

export interface SessionLogEntry {
  scene: number;
  summary: string;
  location: string;
}

export interface GameState {
  initialized: boolean;
  phase: string;
  settingGenre: string;
  settingTone: string;
  settingArchetype: string;
  settingDescription: string;
  playerName: string;
  characterConcept: string;
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
  currentLocation: string;
  currentSceneContext: string;
  timeOfDay: string;
  chaosFactor: number;
  crisisMode: boolean;
  gameOver: boolean;
  sceneCount: number;
  npcs: NPC[];
  clocks: ClockData[];
  storyBlueprint: StoryInfo | null;
  kidMode: boolean;
  sessionLog: SessionLogEntry[];
}

/** Tool result types for this agent, keyed by tool name. */
export type SoloRpgToolResults = ToolResultMap<{
  setup_character: { success: true } & GameState;
  update_state: { success: true } & GameState;
  action_roll: {
    purpose: string;
    move: string;
    stat: string;
    actionDice: [number, number];
    challengeDice: [number, number];
    actionScore: number;
    result: string;
    consequences: Record<string, number | string>;
    clockEvents: Array<{ clockName: string; action: string; filled: number }>;
    chaosInterrupt: string | null;
    currentHealth: number;
    currentSpirit: number;
    currentSupply: number;
    currentMomentum: number;
    chaosFactor: number;
    crisisMode: boolean;
    gameOver: boolean;
    sceneCount: number;
    canBurnMomentum: boolean;
  };
  burn_momentum:
    | {
        burned: true;
        previousMomentum: number;
        newMomentum: number;
        newResult: string;
        challengeDice: [number, number];
      }
    | { error: string };
  load_game:
    | {
        loaded: true;
        playerName: string;
        characterConcept: string;
        settingGenre: string;
        sceneCount: number;
        currentLocation: string;
        initialized: boolean;
      }
    | { error: string };
  save_game: { saved: true; slot: string; name: string; scene: number };
}>;
