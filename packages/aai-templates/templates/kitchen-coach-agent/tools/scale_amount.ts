import { tool } from "@alexkroman1/aai";
import { z } from "zod";
import { MAX_SERVINGS, spokenAmount } from "../shared.ts";

/**
 * Scale one ingredient from the servings a recipe was written for to the servings the
 * cook is making. Arithmetic, so a function and not the model: a model asked for 3/4 of
 * a cup times 5/4 says something plausible and wrong.
 */
export default tool({
  description:
    "Scale an ingredient amount from the servings a recipe is written for to the " +
    "servings the cook is making. Use it for every amount you read out of a recipe that " +
    "was written for a different number of people.",
  ui: { icon: "⚖️", label: "Scaling" },
  inputSchema: z.object({
    amount: z.number().positive().describe("The recipe's amount, e.g. 0.75 for three quarters"),
    unit: z.string().max(20).describe("Its unit as the recipe says it, e.g. 'cup', 'g', 'eggs'"),
    from_servings: z.number().int().min(1).describe("How many the recipe serves"),
    to_servings: z
      .number()
      .int()
      .min(1)
      .max(MAX_SERVINGS)
      .describe("How many they are cooking for"),
  }),
  execute({ amount, unit, from_servings, to_servings }) {
    const scaled = (amount * to_servings) / from_servings;
    return { amount: Math.round(scaled * 100) / 100, unit, say: `${spokenAmount(scaled)} ${unit}` };
  },
});
