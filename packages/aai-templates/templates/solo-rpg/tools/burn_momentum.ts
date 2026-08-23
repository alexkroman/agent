import {
  applyConsequences,
  canBurnMomentum,
  gameSlot,
  inCrisis,
  isGameOver,
  MOMENTUM_RESET,
  RESULT_LABELS,
  revertConsequences,
  storyFlow,
} from "../shared.ts";

/**
 * Gated on `playing.rollResolved` — the state that means "a roll is standing".
 *
 * That gate REPLACES this body's opening `if (!state.lastRoll) return { error:
 * "No recent action roll to upgrade. Roll first." }`, which was `when` written
 * out by hand: "is there a roll to upgrade" is a question about where the game
 * is, not about the data, and the flow's refusal names the position and quotes
 * the state's instruction where that sentence could only assert.
 *
 * The two checks BELOW stay, because they really are about the data: whether
 * the roll was already a Strong Hit, and whether the momentum beats the
 * challenge dice. Those are the rules of the game; the gate is the shape of the
 * turn.
 */
export default storyFlow.tool({
  description:
    "Burn momentum to upgrade the most recent action roll. Only valid when current momentum beats the roll's challenge dice (both dice for a full upgrade, one for Miss to Weak Hit). Reverts the original result's consequences, applies the upgraded result, and resets momentum to +2.",
  when: "playing.rollResolved",
  execute: (_args, ctx) =>
    gameSlot.update(ctx, (state) => {
      const last = state.lastRoll;
      // Reachable only if the position and the campaign disagree — the flow says
      // a roll is standing and nothing recorded one — which no code path
      // produces: `action_roll` writes `lastRoll` and sends `ROLLED` in the same
      // call. Reported rather than thrown, mid-game.
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
        // As `action_roll`: derived rather than copied, because `after` has not
        // run yet when this object is built.
        crisisMode: inCrisis(state),
        gameOver: isGameOver(state),
      };
    }),
  // A burn CONSUMES the standing roll (`lastRoll` is cleared), so the resting
  // event is `SETTLED` rather than `ROLLED` — where `action_roll` leaves one
  // standing, this one spends it. A burn that emptied the last track is as
  // final as a roll that did.
  //
  // `result` is the SUCCESS type — `sendFrom` takes `Exclude<R, ToolFailure>`
  // now, so the `"gameOver" in result` guard that stood in for the failure arm
  // leaking into `R` is a plain property read.
  sendFrom: (result) =>
    result.gameOver ? { type: "DOWNED" as const } : { type: "SETTLED" as const },
});
