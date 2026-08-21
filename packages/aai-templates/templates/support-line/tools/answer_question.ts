import { errorMessage, GraphNotFinishedError, tool, toolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { runCorrectiveRag } from "../graph.ts";
import { recordQuestion, supportSlot } from "../shared.ts";

/**
 * The whole graph, as one tool.
 *
 * The model's ONLY route to an answer — the system prompt forbids answering
 * from memory, and this is what makes that instruction enforceable: everything
 * this returns is either grounded in a document the grader passed, or an
 * admission that nothing covers the question.
 *
 * The verdicts ride back with the answer rather than being swallowed. A
 * grounded-but-not-useful answer is still worth speaking, and the caller is the
 * one who should hear that it may not be the whole story.
 */
export default tool({
  description:
    "Answer a caller's question from the support knowledge base. This is the " +
    "only way to answer anything about the product — never answer from your " +
    "own knowledge. Pass the caller's question as they asked it.",
  inputSchema: z.object({
    question: z.string().max(500).describe("The caller's question, in their own words"),
  }),
  async execute(args, ctx) {
    let trace: Awaited<ReturnType<typeof runCorrectiveRag>>;
    try {
      // `ctx.signal` is what stops the graph on a barge-in: this loop is five
      // to nine model calls, and a caller who interrupts on the second should
      // not be charged for the rest.
      trace = await runCorrectiveRag(ctx.generate, args.question, ctx.signal);
    } catch (err: unknown) {
      // An INTERRUPTED lookup is not a broken one, and the difference is worth
      // a sentence: `ctx.signal` aborts on a barge-in AND on this call's own
      // timeout, and telling the model the knowledge base failed would have it
      // apologize for an outage that did not happen.
      if (err instanceof GraphNotFinishedError) {
        return toolFailure(
          "That lookup was cut short before it finished. Offer to look again, " +
            "or to log a ticket with log_ticket.",
        );
      }
      // A broken model call IS the tool's to report: the model can tell the
      // caller the lookup failed, which is a better turn than silence.
      return toolFailure(`The knowledge base lookup failed: ${errorMessage(err)}`);
    }

    // No `await`: `slot.update` is SYNCHRONOUS, and that is the invariant
    // rather than an implementation detail — the model call above is awaited in
    // FRONT of the mutation for exactly that reason. Awaiting it would read as
    // though the window could span a turn.
    supportSlot.update(ctx, (state) => {
      state.trace = trace;
      recordQuestion(state, args.question);
    });

    const sources = trace.docs.filter((doc) => doc.relevant).map((doc) => doc.title);

    if (!trace.answer) {
      return {
        answer: null,
        rewrites: trace.rewrites,
        guidance:
          "Nothing in the knowledge base covers this. Say so plainly — do not " +
          "guess — and offer to log a ticket with log_ticket.",
      };
    }

    return {
      answer: trace.answer,
      sources,
      grounded: trace.grounded,
      answersTheQuestion: trace.useful,
      rewrites: trace.rewrites,
      ...(trace.exhausted
        ? {
            guidance:
              "This is grounded in the documents but may not be the whole " +
              "answer. Give it, then offer to log a ticket with log_ticket.",
          }
        : {}),
    };
  },
});
