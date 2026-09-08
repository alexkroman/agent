import {
  type DeepReadonly,
  errorMessage,
  isToolFailure,
  omitUndefined,
  type TypedDelegateResult,
  toolFailure,
} from "@alexkroman1/aai";
import { z } from "zod";
import {
  briefingSlot,
  countWork,
  type Finding,
  factChecker,
  findByAngle,
  type Verdict,
} from "../shared.ts";

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
 * thing" as its task would get a confident answer about nothing. The board
 * arrives through `briefingSlot.tool` rather than a `get` inside the body,
 * which is what declares that this tool reads it and never writes.
 */
export default briefingSlot.tool({
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
  async execute(args, board, ctx) {
    const claim = args.claim.trim();
    if (claim === "") return toolFailure("Nothing to check — say the claim in a full sentence.");

    // The caller pointed at something on the board, so an AMBIGUOUS pointer is
    // returned to the model rather than resolved by board order. Checking the
    // claim against the wrong finding is worse than spending a turn asking
    // which — the verdict would come back about a different conversation. A
    // caller who named no angle is the `undefined` case and is fine.
    let source: DeepReadonly<Finding> | undefined;
    if (args.about !== undefined) {
      const found = findByAngle(board, args.about);
      if (isToolFailure(found)) return found;
      source = found;
    }

    let verdict: Verdict | undefined;
    let detail: string;
    let searches: number;
    let unusable: string | undefined;
    try {
      // What the checker gets of the conversation, and no more: the finding the
      // claim came out of, so it can tell a misquote from a disagreement.
      // Through `omitUndefined` rather than a truthiness-guarded spread — the
      // repo's one spelling for an optional field, and the shape its own
      // `guard-invariants` rule 22 counts as debt.
      const context = source ? `The desk told the caller: ${source.summary}` : undefined;
      // ANNOTATED, as `researchAngle`'s plain `DelegateResult` is, and the pair
      // is the lesson: `factChecker` declares a `schema`, so `ctx.delegate`
      // takes its typed overload and the reply carries a parsed `object`. A
      // schema removed upstream lands here as a type error rather than as an
      // `.object` that quietly went `unknown`.
      const result: TypedDelegateResult<Verdict> = await ctx.delegate(factChecker, {
        task: claim,
        ...omitUndefined({ context }),
      });
      searches = countWork(result.toolCalls).searches;
      // `object` is the parsed verdict, present exactly when the run was
      // accepted. The checker's schema sends a mis-shaped answer back; exhausting
      // that budget is not a failure — there IS an answer, and on a live call the
      // desk is better off reading a hedged one and saying it is hedged than
      // apologizing for the tooling. What it must not do is treat it as a verdict
      // it can correct itself from, which is what `unusable` says.
      unusable = result.accepted ? undefined : result.complaint;
      verdict = result.accepted ? result.object : undefined;
      detail = verdict?.detail ?? result.text;
    } catch (err: unknown) {
      return toolFailure(`The check did not come back: ${errorMessage(err)}`);
    }

    return {
      claim,
      // The word the desk BRANCHES on, as a word — not a sentence it has to
      // read a word out of.
      verdict: verdict?.verdict ?? null,
      detail,
      searches,
      checkedAgainst: source?.angle ?? null,
      ...omitUndefined({ unusable }),
      message: unusable
        ? "The checker never gave a clear verdict. Tell the caller it is unresolved " +
          "and offer to research it properly — do not present this as confirmation."
        : "Say the verdict plainly, in the caller's words. If it is contradicted, " +
          "correct what you told them earlier rather than defending it.",
    };
  },
});
