import { resolveOne } from "@alexkroman1/aai";
import { z } from "zod";
import { nightSlot } from "../shared.ts";

/**
 * `nightSlot.tool` rather than `updateTool`: reading the log back writes
 * nothing, and the declaration is what says so — what a read is handed is
 * FROZEN, so a body that tried to edit the night on the way past would not
 * compile. `recommend` beside it is the writing half of the same slot.
 *
 * The log is the reason this tool exists at all. It outlives the transcript
 * the model is holding — a long night trims early turns out of the context
 * window while the slot still has every pick — so "what was that second album
 * again?" is a lookup, not a memory.
 *
 * `resolveOne` is what turns the listener's own words into one of them, and it
 * is the whole body: an index argument would make the model guess a number it
 * cannot see, and the two answers that are not "here it is" — nothing logged
 * yet, and words that fit two entries equally — are refusals it writes,
 * LISTING the candidates so the companion can read them back and ask. Never a
 * guess: reading out the spooky book when they asked for the cozy one is worse
 * than asking which.
 *
 * Positions are chronological, because that is what a listener means: `recs`
 * is stored oldest-first, so "the first one you gave me" is `at(0)` and "the
 * last one" is `at(-1)`. The sidebar paints the same list newest-first, which
 * is `nightProjection`'s doing and no business of this lookup.
 */
export default nightSlot.tool({
  description:
    "Read back one recommendation already given tonight — the listener names it in their own words (\"the second one\", \"the last one\", \"those cozy movies\").",
  inputSchema: z.object({
    which: z
      .string()
      .describe("How the listener referred to it, in their words — do not translate it."),
  }),
  execute: ({ which }, night) =>
    resolveOne(night.recs, which, {
      label: "recommendation",
      // How a refusal reads them back, so it has to be sayable: "cozy movies,
      // spooky books". The picks themselves are what the answer carries.
      describe: (rec) => `${rec.mood} ${rec.category}s`,
      // Two words the listener can name, scored independently: "the spooky
      // books" beats a spooky MOVIE and a cozy BOOK, and "the spooky ones"
      // ties them — which is a refusal that asks, not a coin flip.
      score: (rec, text) =>
        (text.includes(rec.mood) ? 1 : 0) + (text.includes(rec.category) ? 1 : 0),
    }),
});
