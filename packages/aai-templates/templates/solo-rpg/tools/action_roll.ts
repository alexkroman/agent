import { tool } from "aai";
import { z } from "zod";
import type { GameState, KV } from "../shared.ts";
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
} from "../shared.ts";

export const actionRoll = tool({
  description:
    "Core mechanic. Roll 2d6 + stat (capped at 10) vs 2d10 challenge dice. Also applies consequences (health/spirit/supply/momentum changes, clock advancement) based on move type, position, and result. Call for ANY risky action.",
  parameters: z.object({
    move: z
      .enum([
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
      ])
      .describe("Which move the player is making"),
    stat: z.enum(["edge", "heart", "iron", "shadow", "wits"]).describe("Which stat to roll"),
    position: z
      .enum(["controlled", "risky", "desperate"])
      .describe("How dangerous the situation is"),
    effect: z.enum(["limited", "standard", "great"]).describe("What can realistically be achieved"),
    purpose: z.string().describe("What the character is attempting"),
    targetNpcId: z.string().describe("Target NPC id for social moves").optional(),
  }),
  async execute(args, ctx: { kv: KV }) {
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
  },
});
