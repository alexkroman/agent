import type { GameState, KV } from "../_shared.ts";
import {
  applyConsequences,
  canBurnMomentum,
  checkChaosInterrupt,
  getGameState,
  MOVE_LABELS,
  RESULT_LABELS,
  rollAction,
  saveGameState,
  updateChaosFactor,
} from "../_shared.ts";

export const description =
  "Core mechanic. Roll 2d6 + stat (capped at 10) vs 2d10 challenge dice. Also applies consequences (health/spirit/supply/momentum changes, clock advancement) based on move type, position, and result. Call for ANY risky action.";

export const parameters = {
  type: "object",
  properties: {
    move: {
      type: "string",
      enum: [
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
      ],
      description: "Which move the player is making",
    },
    stat: {
      type: "string",
      enum: ["edge", "heart", "iron", "shadow", "wits"],
      description: "Which stat to roll",
    },
    position: {
      type: "string",
      enum: ["controlled", "risky", "desperate"],
      description: "How dangerous the situation is",
    },
    effect: {
      type: "string",
      enum: ["limited", "standard", "great"],
      description: "What can realistically be achieved",
    },
    purpose: { type: "string", description: "What the character is attempting" },
    targetNpcId: { type: "string", description: "Target NPC id for social moves" },
  },
  required: ["move", "stat", "position", "effect", "purpose"],
};

export default async function execute(
  args: {
    move: string;
    stat: string;
    position: string;
    effect: string;
    purpose: string;
    targetNpcId?: string;
  },
  ctx: { kv: KV },
) {
  const state = await getGameState(ctx.kv);
  const statValue = state[args.stat as keyof GameState] as number;
  const roll = rollAction(args.stat, statValue, args.move);

  // Apply consequences
  const { consequences, clockEvents } = applyConsequences(
    state,
    roll,
    args.position,
    args.effect,
    args.targetNpcId ?? null,
  );

  // Update chaos factor
  updateChaosFactor(state, roll.result);

  // Check for chaos interrupt
  const interrupt = checkChaosInterrupt(state);

  // Increment scene count
  state.sceneCount++;

  // Can burn momentum?
  const burnTarget = canBurnMomentum(state, roll);

  await saveGameState(ctx.kv, state);

  return {
    purpose: args.purpose,
    move: MOVE_LABELS[args.move] || args.move,
    moveCode: args.move,
    stat: args.stat,
    statValue,
    actionDice: [roll.d1, roll.d2],
    challengeDice: [roll.c1, roll.c2],
    actionScore: roll.actionScore,
    result: RESULT_LABELS[roll.result],
    resultCode: roll.result,
    match: roll.match,
    matchNote: roll.match
      ? roll.result === "STRONG_HIT" || roll.result === "WEAK_HIT"
        ? "Fateful roll. Both challenge dice match. An unexpected advantage or twist."
        : "Fateful roll. Both challenge dice match. A dire and dramatic escalation."
      : undefined,
    position: args.position,
    effect: args.effect,
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
    canBurnMomentum: Boolean(burnTarget),
    burnWouldYield: burnTarget ? RESULT_LABELS[burnTarget] : undefined,
  };
}
