import { tool } from "@alexkroman1/aai";
import {
  applyConsequences,
  canBurnMomentum,
  gameSlot,
  MOMENTUM_RESET,
  RESULT_LABELS,
  revertConsequences,
} from "../shared.ts";

export default tool({
  description:
    "Burn momentum to upgrade the most recent action roll. Only valid when current momentum beats the roll's challenge dice (both dice for a full upgrade, one for Miss to Weak Hit). Reverts the original result's consequences, applies the upgraded result, and resets momentum to +2.",
  async execute(_args, ctx) {
    const state = gameSlot.get(ctx);
    const last = state.lastRoll;
    if (!last) return { error: "No recent action roll to upgrade. Roll first." };
    if (last.result === "STRONG_HIT") {
      return { error: "The last roll was already a Strong Hit. Nothing to upgrade." };
    }

    const upgrade = canBurnMomentum(state, last);
    if (!upgrade) {
      return {
        error:
          state.momentum <= 0
            ? "Momentum is 0 or negative. Cannot burn."
            : "Momentum not high enough to improve the result.",
      };
    }

    const previousMomentum = state.momentum;
    const previousResult = last.result;

    // Undo exactly what the original result applied, then apply the
    // upgraded result's effects (bond/disposition/momentum gains).
    revertConsequences(state, last.deltas);
    const upgraded = { ...last, result: upgrade };
    const { consequences, clockEvents } = applyConsequences(
      state,
      upgraded,
      last.position,
      last.effect,
      last.targetNpcId,
    );

    // Burning always resets momentum, overriding any gain from the upgrade.
    state.momentum = MOMENTUM_RESET;
    state.lastRoll = null;

    return {
      burned: true,
      previousMomentum,
      newMomentum: MOMENTUM_RESET,
      previousResult: RESULT_LABELS[previousResult],
      newResult: RESULT_LABELS[upgrade],
      newResultCode: upgrade,
      challengeDice: [last.c1, last.c2],
      revertedConsequences: true,
      consequences,
      clockEvents,
      currentHealth: state.health,
      currentSpirit: state.spirit,
      currentSupply: state.supply,
      crisisMode: state.crisisMode,
      gameOver: state.gameOver,
    };
  },
});
