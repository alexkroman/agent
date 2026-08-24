import { errorMessage, omitUndefined, tool, toolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { briefingSlot, countWork, factChecker, findByAngle } from "../shared.ts";

/**
 * Check one sentence against the web, on the narrower of the desk's two
 * subagents.
 *
 * **Why this is a second SUBAGENT and not a second prompt.** Checking a claim
 * needs a search and one sentence back, so it runs on a cheaper model with a
 * third of the researcher's budget and search only — no page reads. Expressing
 * that as `ctx.generate` would mean the desk doing the searching itself, in the
 * conversation's own context; expressing it as one subagent with two modes
 * would mean a run that can browse whenever the model feels like it. A
 * capability a run does not need is one it cannot misuse.
 *
 * **The claim may be quoted from the board.** The caller says "check the second
 * thing you told me", so `about` names an angle and the claim is read out of
 * the slot — a subagent has not heard the call, and handing it "the second
 * thing" as its task would get a confident answer about nothing.
 */
export default tool({
  description:
    "Check one specific factual claim against the web. Use it when the caller " +
    "pushes back on something, or asks whether a finding is right. Pass the " +
    "claim as a complete sentence.",
  inputSchema: z.object({
    claim: z
      .string()
      .max(400)
      .describe("The claim to check, stated as one self-contained sentence"),
    about: z
      .string()
      .max(200)
      .optional()
      .describe(
        "The angle this claim came from, when the caller is pointing at " +
          "something already on the board",
      ),
  }),
  async execute(args, ctx) {
    const claim = args.claim.trim();
    if (claim === "") return toolFailure("Nothing to check — say the claim in a full sentence.");

    const board = briefingSlot.get(ctx);
    const source = args.about ? findByAngle(board, args.about) : undefined;

    let verdict: string;
    let searches: number;
    try {
      // What the checker gets of the conversation, and no more: the finding the
      // claim came out of, so it can tell a misquote from a disagreement.
      // Through `omitUndefined` rather than a truthiness-guarded spread — the
      // repo's one spelling for an optional field, and the shape its own
      // `guard-invariants` rule 22 counts as debt.
      const context = source ? `The desk told the caller: ${source.summary}` : undefined;
      const result = await ctx.delegate(factChecker, {
        task: claim,
        ...omitUndefined({ context }),
      });
      verdict = result.text;
      searches = countWork(result.toolCalls).searches;
    } catch (err: unknown) {
      return toolFailure(`The check did not come back: ${errorMessage(err)}`);
    }

    return {
      claim,
      verdict,
      searches,
      checkedAgainst: source?.angle ?? null,
      message:
        "Say the verdict plainly, in the caller's words. If it is contradicted, " +
        "correct what you told them earlier rather than defending it.",
    };
  },
});
