import { tool } from "@alexkroman1/aai";
import { z } from "zod";
import { briefingSlot } from "../shared.ts";

/**
 * Read the board back.
 *
 * The one tool here that spends no model at all, and it earns its place for
 * that reason: a caller who says "what have you got so far" after four
 * delegated runs should not cost a fifth. What the desk knows is on the slot;
 * this hands it over.
 */
export default tool({
  description:
    "List the angles researched on this call and what each one found. Use it " +
    "when the caller asks for a recap, or before you offer to dig further.",
  inputSchema: z.object({}),
  execute: (_args, ctx) => {
    const board = briefingSlot.get(ctx);
    if (board.findings.length === 0) {
      return {
        topic: null,
        findings: [],
        message: "Nothing researched yet — ask what they want looked into.",
      };
    }
    return {
      topic: board.topic,
      findings: board.findings,
      totalSearches: board.findings.reduce((sum, finding) => sum + finding.work.searches, 0),
      totalReads: board.findings.reduce((sum, finding) => sum + finding.work.reads, 0),
      message: "Recap the through-line in one breath, then offer to go deeper on one angle.",
    };
  },
});
