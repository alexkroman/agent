import { toolFailure } from "@alexkroman1/aai/utils";
import {
  applyConsequences,
  canBurnMomentum,
  gameSlot,
  MOMENTUM_RESET,
  RESULT_LABELS,
  revertConsequences,
  storyFlow,
} from "../shared.ts";

/**
 * Gated on `playing.rollResolved` — "is there a roll to upgrade" is a question
 * about where the game is, and the flow's refusal names the position. The
 * `require` below is about the DATA: whether the roll was already a Strong
 * Hit, and whether the momentum beats the challenge dice.
 */
export default gameSlot.updateTool({
  description:
    "Burn momentum to upgrade the most recent action roll. Only valid when current momentum beats the roll's challenge dice (both dice for a full upgrade, one for Miss to Weak Hit). Reverts the original result's consequences, applies the upgraded result, and resets momentum to +2.",
  dialog: storyFlow,
  when: "playing.rollResolved",
  require: (game) => {
    const last = game.lastRoll;
    // Reachable only if the position and the campaign disagree, which no
    // code path produces: `action_roll` writes `lastRoll` and sends `ROLLED`
    // in the same call.
    if (!last) return toolFailure("No recent action roll to upgrade. Roll first.");
    if (last.result === "STRONG_HIT") {
      return toolFailure("The last roll was already a Strong Hit. Nothing to upgrade.");
    }
    if (canBurnMomentum(game, last)) return;
    return toolFailure(
      game.momentum <= 0
        ? "Momentum is 0 or negative. Cannot burn."
        : "Momentum not high enough to improve the result.",
    );
  },
  execute(_args, state) {
    // `require` has just checked all three; the non-null assertions restate it.
    const last = state.lastRoll!;
    const upgrade = canBurnMomentum(state, last)!;
    const previousMomentum = state.momentum;
    const previousResult = last.result;

    // Undo exactly what the original result applied, then apply the
    // upgraded result's effects (bond/disposition/momentum gains).
    revertConsequences(state, last.deltas);
    const { consequences, clockEvents } = applyConsequences(
      state,
      { ...last, result: upgrade },
      last.position,
      last.effect,
      last.targetNpcId,
    );

    // Burning always resets momentum, overriding any gain from the upgrade,
    // and CONSUMES the standing roll.
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
    };
  },
  report: (stored, partial) => ({
    ...partial,
    crisisMode: stored.crisisMode,
    gameOver: stored.gameOver,
  }),
  // A burn spends the standing roll, so the resting event is `SETTLED`; a
  // burn that emptied the last track is as final as a roll that did.
  sendFrom: (result) =>
    result.gameOver ? { type: "DOWNED" as const } : { type: "SETTLED" as const },
});
