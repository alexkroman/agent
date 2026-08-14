/**
 * The corrective-RAG loop, node by node.
 *
 * This is the port of the self-RAG / CRAG graph (see `prompts.ts` for the
 * attribution). Their control flow is edges between nodes; here it is a `while`
 * loop in one tool body, and the node names survive in {@link AnswerTrace.steps}
 * so a run is still readable as the graph it came from:
 *
 * ```text
 * retrieve → grade_documents → decide_to_generate
 *                                ├─ no relevant docs → transform_query → retrieve
 *                                └─ generate → grade_generation_v_documents
 *                                                ├─ not grounded → generate (once)
 *                                                └─ grade_generation_v_question
 *                                                     ├─ not useful → transform_query
 *                                                     └─ done
 * ```
 *
 * **The budget is the mechanism, not the prompt.** A graph with a
 * `transform_query` edge can cycle, and their notebooks bound it with a recursion
 * limit that raises on hit. A caller is holding the line, so the bound here is
 * two attempts and one regeneration — {@link MAX_ATTEMPTS} — and running out is
 * an ANSWER (`exhausted`, the caller is offered a ticket) rather than an error.
 * An agent that cannot say "I don't have that documented" is the failure the
 * whole grading apparatus exists to prevent, so it has to be a reachable state.
 *
 * **Documents are graded CONCURRENTLY.** Their loop is sequential because a
 * notebook does not care; four serial grader calls is four round trips of dead
 * air on a phone. The grades are independent, so the fan-out is free.
 */

import type { GenerateFn } from "@alexkroman1/aai";
import {
  ANSWER_SYSTEM,
  ANSWERS_SYSTEM,
  binaryScore,
  DOC_GRADER_SYSTEM,
  GROUNDED_SYSTEM,
  REWRITE_SYSTEM,
} from "./prompts.ts";
import type { AnswerTrace, Doc, GradedDoc, TraceStep } from "./shared.ts";
import { formatDoc, retrieve } from "./shared.ts";

/** Retrieve-and-answer attempts, i.e. one query rewrite. */
export const MAX_ATTEMPTS = 2;
/** Regenerations after a "not grounded" verdict, within one attempt. */
export const MAX_REGENERATIONS = 1;

function step(trace: AnswerTrace, node: string, detail: string): void {
  const entry: TraceStep = { node, detail };
  trace.steps.push(entry);
}

/** `grade_documents` — one closed question per document, all at once. */
async function gradeDocuments(
  generate: GenerateFn,
  question: string,
  docs: Doc[],
): Promise<GradedDoc[]> {
  return await Promise.all(
    docs.map(async (doc) => {
      const { object } = await generate({
        system: DOC_GRADER_SYSTEM,
        prompt: `Caller's question: ${question}\n\nDocument:\n${formatDoc(doc)}`,
        schema: binaryScore,
      });
      return {
        id: doc.id,
        title: doc.title,
        relevant: object.score === "yes",
        reason: object.reason,
      };
    }),
  );
}

/** `transform_query` — their question re-writer, aimed at a keyword index. */
async function transformQuery(generate: GenerateFn, question: string): Promise<string> {
  const { text } = await generate({
    system: REWRITE_SYSTEM,
    prompt: `Caller's question: ${question}`,
  });
  const rewritten = text.trim().replace(/^["']|["']$/g, "");
  // A rewriter that returns nothing usable must not empty the query — that
  // would retrieve zero documents and read as "we have nothing on this".
  return rewritten.length > 0 ? rewritten : question;
}

/** `generate` — the answer, from the graded-relevant documents only. */
async function generateAnswer(
  generate: GenerateFn,
  question: string,
  docs: Doc[],
): Promise<string> {
  const { text } = await generate({
    system: ANSWER_SYSTEM,
    prompt: `Documents:\n\n${docs.map(formatDoc).join("\n\n")}\n\nCaller's question: ${question}`,
  });
  return text.trim();
}

/** The two generation graders — same closed question, different subject. */
async function grade(
  generate: GenerateFn,
  system: string,
  prompt: string,
): Promise<{ pass: boolean; reason: string }> {
  const { object } = await generate({ system, prompt, schema: binaryScore });
  return { pass: object.score === "yes", reason: object.reason };
}

/**
 * Run the graph for one caller question. Never throws for a bad ANSWER — only
 * for a broken model call, which is the tool's to report.
 */
export async function runCorrectiveRag(
  generate: GenerateFn,
  question: string,
): Promise<AnswerTrace> {
  const trace: AnswerTrace = {
    question,
    query: question,
    rewrites: 0,
    steps: [],
    docs: [],
    answer: null,
    grounded: null,
    useful: null,
    exhausted: false,
  };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const retrieved = retrieve(trace.query);
    step(trace, "retrieve", `${retrieved.length} document(s) for "${trace.query}"`);

    const graded = await gradeDocuments(
      generate,
      question,
      retrieved.map((one) => one.doc),
    );
    trace.docs = graded;
    const relevant = retrieved.filter((one) => graded.find((g) => g.id === one.doc.id)?.relevant);
    step(trace, "grade_documents", `${relevant.length} of ${graded.length} relevant`);

    // `decide_to_generate`: nothing relevant means the retrieval was wrong, not
    // that the answer is unknown — so rewrite and try once more before giving up.
    if (relevant.length === 0) {
      if (attempt < MAX_ATTEMPTS) {
        trace.query = await transformQuery(generate, question);
        trace.rewrites++;
        step(trace, "transform_query", `retrying as "${trace.query}"`);
        continue;
      }
      trace.exhausted = true;
      step(trace, "decide_to_generate", "no relevant documents, and no attempts left");
      return trace;
    }

    const docs = relevant.map((one) => one.doc);
    const facts = docs.map(formatDoc).join("\n\n");
    let answer = await generateAnswer(generate, question, docs);
    step(trace, "generate", `answered from ${docs.map((d) => d.id).join(", ")}`);

    // `grade_generation_v_documents`: is it grounded? A regeneration is worth
    // one shot — the same documents with the ungrounded attempt now visible.
    let grounded = await grade(
      generate,
      GROUNDED_SYSTEM,
      `Facts:\n\n${facts}\n\nAnswer: ${answer}`,
    );
    for (let redo = 0; !grounded.pass && redo < MAX_REGENERATIONS; redo++) {
      step(trace, "grade_generation_v_documents", `not grounded: ${grounded.reason}`);
      answer = await generateAnswer(generate, question, docs);
      step(trace, "generate", "regenerated");
      grounded = await grade(generate, GROUNDED_SYSTEM, `Facts:\n\n${facts}\n\nAnswer: ${answer}`);
    }
    trace.answer = answer;
    trace.grounded = grounded.pass;
    step(
      trace,
      "grade_generation_v_documents",
      grounded.pass ? "grounded" : `still not grounded: ${grounded.reason}`,
    );
    if (!grounded.pass) {
      // An ungrounded answer is never spoken. Two regenerations that both
      // invented something is a signal about the documents, not the phrasing.
      trace.answer = null;
      trace.exhausted = true;
      return trace;
    }

    // `grade_generation_v_question`: grounded is not the same as useful.
    const useful = await grade(
      generate,
      ANSWERS_SYSTEM,
      `Question: ${question}\n\nAnswer: ${answer}`,
    );
    trace.useful = useful.pass;
    step(
      trace,
      "grade_generation_v_question",
      useful.pass ? "useful" : `not useful: ${useful.reason}`,
    );
    if (useful.pass) return trace;

    if (attempt < MAX_ATTEMPTS) {
      trace.query = await transformQuery(generate, question);
      trace.rewrites++;
      step(trace, "transform_query", `retrying as "${trace.query}"`);
      trace.answer = null;
      trace.grounded = null;
      trace.useful = null;
      continue;
    }
    // Out of attempts holding an answer that is grounded but beside the point.
    // It is still the best thing we have, so it is returned WITH its verdict —
    // the tool tells the model to offer a ticket alongside it.
    trace.exhausted = true;
    return trace;
  }

  trace.exhausted = true;
  return trace;
}
