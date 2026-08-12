import { tool } from "@alexkroman1/aai";
import { z } from "zod";
import {
  applyConsequences,
  canBurnMomentum,
  checkChaosInterrupt,
  gameSlot,
  MOVE_LABELS,
  MOVES,
  RESULT_LABELS,
  rollAction,
  updateChaosFactor,
} from "../shared.ts";

export const actionRoll = tool({
  description:
    "Core mechanic. Roll 2d6 + stat (capped at 10) vs 2d10 challenge dice. Also applies consequences (health/spirit/supply/momentum changes, clock advancement) based on move type, position, and result. Call for ANY risky action. Pure conversation needs no roll.",
  input: z.object({
    move: z.enum(MOVES).describe("Which move the player is making"),
    stat: z.enum(["edge", "heart", "iron", "shadow", "wits"]).describe("Which stat to roll"),
    position: z
      .enum(["controlled", "risky", "desperate"])
      .describe("How dangerous the situation is"),
    effect: z.enum(["limited", "standard", "great"]).describe("What can realistically be achieved"),
    purpose: z.string().max(300).describe("What the character is attempting"),
    targetNpcId: z.string().max(32).describe("Target NPC id for social moves").optional(),
  }),
  async run(args, ctx) {
    const state = gameSlot.get(ctx);
    const statValue = state[args.stat];
    const roll = rollAction(args.stat, statValue, args.move);

    // Apply consequences
    const { consequences, clockEvents, deltas } = applyConsequences(
      state,
      roll,
      args.position,
      args.effect,
      args.targetNpcId ?? null,
    );

    // Persist the roll (with the exact deltas applied) so burn_momentum can
    // validate against it and revert it — the model never supplies dice.
    state.lastRoll = {
      ...roll,
      position: args.position,
      effect: args.effect,
      targetNpcId: args.targetNpcId ?? null,
      deltas,
    };

    // Update chaos factor
    updateChaosFactor(state, roll.result);

    // Check for chaos interrupt
    const interrupt = checkChaosInterrupt(state);

    // Increment scene count
    state.sceneCount++;

    // Can burn momentum?
    const burnTarget = canBurnMomentum(state, roll);

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
