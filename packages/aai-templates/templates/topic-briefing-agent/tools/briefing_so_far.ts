import { z } from "zod";
import { briefingSlot, totalWork } from "../shared.ts";

/**
 * Read the board back.
 *
 * The one tool here that spends no model at all, and it earns its place for
 * that reason: a caller who says "what have you got so far" after four
 * delegated runs should not cost a fifth. What the desk knows is on the slot;
 * this hands it over.
 *
 * **Declared as `briefingSlot.tool`**, which is the SDK's way of saying "this
 * one reads": the board arrives as an argument, deep-frozen, so nothing here
 * can quietly write to it and a body that tried would not compile. It used to
 * be a `tool()` opening with `briefingSlot.get(ctx)` — the same behaviour with
 * the declaration doing none of the work.
 */
export default briefingSlot.tool({
  description:
    "List the angles researched on this call and what each one found. Use it " +
    "when the caller asks for a recap, or before you offer to dig further.",
  inputSchema: z.object({}),
  execute: (_args, board) => {
    if (board.findings.length === 0) {
      return {
        topic: null,
        findings: [],
        message: "Nothing researched yet — ask what they want looked into.",
      };
    }
    // `totalWork` rather than two `reduce`s here: `slack.ts` says the same
    // numbers in writing, and a recap that counts one way while the Slack post
    // counts another is a disagreement nobody would think to test for.
    const { searches, reads } = totalWork(board.findings);
    return {
      topic: board.topic,
      findings: board.findings,
      totalSearches: searches,
      totalReads: reads,
      message: "Recap the through-line in one breath, then offer to go deeper on one angle.",
    };
  },
});
