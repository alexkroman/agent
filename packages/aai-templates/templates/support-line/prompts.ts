/**
 * The graders, the rewriter and the answer prompt — and where they come from.
 *
 * **Adapted from LangGraph's self-RAG and corrective-RAG notebooks** (MIT,
 * <https://github.com/langchain-ai/langgraph>,
 * `docs/docs/tutorials/rag/langgraph_self_rag.ipynb` and
 * `langgraph_crag.ipynb`), whose graders are `ChatPromptTemplate`s bound to
 * small pydantic models with one field: a binary `"yes"`/`"no"` score.
 *
 * | self-RAG / CRAG node | here |
 * | --- | --- |
 * | `retrieval_grader` (`GradeDocuments`) | {@link DOC_GRADER_SYSTEM} + {@link binaryScore} |
 * | `question_rewriter` | {@link REWRITE_SYSTEM} |
 * | `rag_chain` (`rlm/rag-prompt`) | {@link ANSWER_SYSTEM} |
 * | `hallucination_grader` (`GradeHallucinations`) | {@link GROUNDED_SYSTEM} |
 * | `answer_grader` (`GradeAnswer`) | {@link ANSWERS_SYSTEM} |
 *
 * **The binary score is the load-bearing part and it is kept verbatim in
 * shape.** Their whole design rests on asking a model one closed question at a
 * time rather than "is this good?", because a closed question is one a small
 * model answers reliably and a caller's answer can be routed on. `reason` is an
 * addition: it costs a few tokens, it is what the sidebar renders per document,
 * and asking for it is the cheapest way to see WHY a grader is being strict.
 *
 * What is adapted is the audience. Theirs answer into a notebook and may take
 * three sentences of markdown; ours is read down a phone by a support line, so
 * {@link ANSWER_SYSTEM} asks for two spoken sentences and forbids the "based on
 * the provided context" preamble that a caller hears as evasion.
 */

import { z } from "zod";

/**
 * Their `GradeDocuments` / `GradeHallucinations` / `GradeAnswer`, as one
 * schema — all three are the same closed question with a different subject, and
 * `ctx.generate({ schema })` constrains the model to it.
 */
export const binaryScore = z.object({
  score: z.enum(["yes", "no"]).describe("Binary score, 'yes' or 'no'"),
  reason: z.string().max(200).describe("One short sentence of justification"),
});

/** Their `retrieval_grader`: deliberately NOT a stringent test. */
export const DOC_GRADER_SYSTEM = [
  "You are a grader assessing whether a retrieved support document is relevant",
  "to a caller's question. If the document contains keywords or meaning related",
  "to the question, grade it relevant. This does not need to be a stringent",
  "test — the goal is to filter out erroneous retrievals, not to pick the single",
  "best document. Documents about a NEIGHBOURING subject (cancelling an",
  "appointment when the caller asked about cancelling a contract) are NOT",
  "relevant; answering from one of those is the specific mistake you exist to",
  "prevent.",
  "Give a binary score, 'yes' or 'no'.",
].join(" ");

/** Their `question_rewriter`, retargeted from a vectorstore to a keyword index. */
export const REWRITE_SYSTEM = [
  "You rewrite a caller's spoken question into a better search query for a",
  "support knowledge base that matches on WORDS, not meaning.",
  "Reason about what the caller actually means, then write the terms a support",
  "document about it would itself use — including the words they did not say.",
  '"my internet keeps dying at night" should become something like',
  '"evening slowdown congestion speed drops peak time".',
  "Reply with the query alone: no quotes, no explanation, under fifteen words.",
].join(" ");

/** Their `rag_chain` prompt, rewritten for a voice line. */
export const ANSWER_SYSTEM = [
  "You are a support agent answering a caller using ONLY the documents given to",
  "you. If the documents do not contain the answer, say you do not have it",
  "documented — do not fill the gap from general knowledge.",
  "Two sentences maximum, spoken plainly, as you would say them out loud.",
  "Never say 'based on the provided context' or 'according to the documents':",
  "the caller hears that as evasion. Just answer.",
  "Give the specific number, fee or step where the documents have one.",
].join(" ");

/** Their `hallucination_grader`. */
export const GROUNDED_SYSTEM = [
  "You are a grader assessing whether an answer is grounded in and supported by",
  "a set of facts. Give a binary score, 'yes' or 'no'.",
  "'Yes' means every claim in the answer is supported by the facts.",
  "An answer that says it does not know is grounded — refusing to guess is",
  "supported by any set of facts.",
].join(" ");

/** Their `answer_grader`: grounded is not the same as useful. */
export const ANSWERS_SYSTEM = [
  "You are a grader assessing whether an answer actually resolves the caller's",
  "question. Give a binary score, 'yes' or 'no'.",
  "'Yes' means the caller now knows what to do or what is true.",
  "An answer that is correct but about something adjacent scores 'no'.",
].join(" ");
