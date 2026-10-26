import {
  errorMessage,
  ProcedureNotFinishedError,
  toolFailure,
  withInstruction,
} from "@alexkroman1/aai";
import { z } from "zod";
import { runCorrectiveRag } from "../procedure.ts";
import { supportSlot } from "../shared.ts";

/**
 * Room left under the deadline for this tool's own bookkeeping: unwinding the
 * graph, writing the trace to the slot, and composing the sentence the caller
 * hears. Subtracted from `ctx.deadlineAt`, never from a copy of the deadline.
 */
const WRAP_UP_MS = 2000;

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
 *
 * `prepare` is the graph (an await); `execute` is the synchronous window that
 * records its trace. **The loop is given a BUDGET, because the runtime already
 * has one and it is not this tool's.** The corrective path is up to eleven
 * sequential model calls, and the tool executor abandons any tool at
 * `TOOL_EXECUTION_TIMEOUT_MS` (30s), which an author cannot raise. Measured
 * against a live gateway, the two-attempt path really did exceed it once: the
 * model was handed `{"error":"Tool \"answer_question\" timed out after 30000ms"}`,
 * which tells it nothing it can act on and reads to a caller as the line going
 * dead. Budgeting under `ctx.deadlineAt` lands the overrun on the graph's OWN
 * exit instead — the same "offer to look again, or log a ticket" the design
 * already has for an interrupted run — so the slow path degrades into a
 * sentence rather than into an internal error.
 *
 * **Re-measured, and the loop is nowhere near the budget today.** Driven
 * directly against the live gateway on the default model: the single-attempt
 * path is 2.0-3.1s over four or five model calls, and the two-attempt
 * CORRECTIVE path — nine calls, one query rewrite — is 2.8s. So the budget is a
 * GUARD against a slow gateway rather than a bound the healthy path pushes
 * against. Keep it: what changed is the service's latency, not the number of
 * round trips. Do not go cutting round trips out of the graph on the strength
 * of the old paragraph — measure first, the same way.
 */
export default supportSlot.updateTool({
  description:
    "Answer a caller's question from the support knowledge base. This is the " +
    "only way to answer anything about the product — never answer from your " +
    "own knowledge. Pass the caller's question as they asked it.",
  ui: { icon: "\u{1F50D}", label: "Checking the knowledge base" },
  inputSchema: z.object({
    question: z.string().max(500).describe("The caller's question, in their own words"),
  }),
  async prepare(args, _state, ctx) {
    try {
      // `ctx.signal` is what stops the graph on a barge-in: this loop is five
      // to nine model calls, and a caller who interrupts on the second should
      // not be charged for the rest. The budget rides alongside it and comes
      // from `ctx.deadlineAt` — THIS call's deadline, so a host that gave this
      // tool a different `timeoutMs` is followed rather than second-guessed —
      // read against `ctx.now()`, the clock a spec can pin.
      const budgetMs = Math.max(0, ctx.deadlineAt - ctx.now() - WRAP_UP_MS);
      return await runCorrectiveRag(
        ctx.generate,
        args.question,
        AbortSignal.any([ctx.signal, AbortSignal.timeout(budgetMs)]),
      );
    } catch (err: unknown) {
      // An INTERRUPTED lookup is not a broken one, and the difference is worth
      // a sentence: telling the model the knowledge base failed would have it
      // apologize for an outage that did not happen. Which of the two signals
      // fired decides WHICH sentence — a barge-in means the caller is already
      // talking, and a spent budget means they are still waiting.
      if (err instanceof ProcedureNotFinishedError) {
        return toolFailure(
          ctx.signal.aborted
            ? "That lookup was cut short before it finished. Offer to look again, " +
                "or to log a ticket with log_ticket."
            : "That lookup ran out of time before it could be graded, so there is no " +
                "answer to give. Say the check is taking too long, offer a narrower " +
                "question, and offer to log a ticket with log_ticket. Do not answer " +
                "from your own knowledge.",
        );
      }
      // A broken model call IS the tool's to report: the model can tell the
      // caller the lookup failed, which is a better turn than silence.
      return toolFailure(`The knowledge base lookup failed: ${errorMessage(err)}`);
    }
  },
  execute(args, state, trace) {
    state.trace = trace;
    state.asked.push(args.question);

    if (!trace.answer) {
      return withInstruction(
        { answer: null, rewrites: trace.rewrites },
        "Nothing in the knowledge base covers this. Say so plainly — do not " +
          "guess — and offer to log a ticket with log_ticket.",
      );
    }

    const answered = {
      answer: trace.answer,
      sources: trace.docs.filter((doc) => doc.relevant).map((doc) => doc.title),
      grounded: trace.grounded,
      answersTheQuestion: trace.useful,
      rewrites: trace.rewrites,
    };
    return trace.exhausted
      ? withInstruction(
          answered,
          "This is grounded in the documents but may not be the whole answer. " +
            "Give it, then offer to log a ticket with log_ticket.",
        )
      : answered;
  },
});
