import type { KV } from "../_shared.ts";
import { getGameState, saveGameState } from "../_shared.ts";

export default async function execute(args: { c1: number; c2: number }, ctx: { kv: KV }) {
  const state = await getGameState(ctx.kv);
  const mom = state.momentum;
  if (mom <= 0) return { error: "Momentum is 0 or negative. Cannot burn." };

  let newResult: string;
  if (mom > args.c1 && mom > args.c2) newResult = "STRONG_HIT";
  else if (mom > args.c1 || mom > args.c2) newResult = "WEAK_HIT";
  else return { error: "Momentum not high enough to improve the result." };

  const previousMomentum = mom;
  state.momentum = 2; // Reset to starting value
  await saveGameState(ctx.kv, state);

  const labels: Record<string, string> = {
    STRONG_HIT: "Strong Hit",
    WEAK_HIT: "Weak Hit",
  };

  return {
    burned: true,
    previousMomentum,
    newMomentum: 2,
    newResult: labels[newResult],
    newResultCode: newResult,
    challengeDice: [args.c1, args.c2],
  };
}
