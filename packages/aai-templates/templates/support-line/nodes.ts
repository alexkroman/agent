/**
 * The CRAG nodes' BODIES — one model call each, and nothing about routing.
 *
 * Split from `procedure.ts` when that file became an actual machine: the machine
 * there declares which node runs next, and these are what each node does. The
 * seam is worth having beyond the line count — everything here is a plain async
 * function of its arguments, so a spec can drive one directly, and the machine
 * holds no prompt text at all.
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
import type { Doc, GradedDoc } from "./shared.ts";
import { formatDoc } from "./shared.ts";

/** A closed verdict from one of the graders. */
export interface Verdict {
  pass: boolean;
  reason: string;
}

/** `grade_documents` — one closed question per document, all at once. */
export async function gradeDocuments(
  generate: GenerateFn,
  question: string,
  docs: readonly Doc[],
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
export async function transformQuery(generate: GenerateFn, question: string): Promise<string> {
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
export async function generateAnswer(
  generate: GenerateFn,
  question: string,
  docs: readonly Doc[],
): Promise<string> {
  const { text } = await generate({
    system: ANSWER_SYSTEM,
    prompt: `Documents:\n\n${docs.map(formatDoc).join("\n\n")}\n\nCaller's question: ${question}`,
  });
  return text.trim();
}

/** The two generation graders — same closed question, different subject. */
async function grade(generate: GenerateFn, system: string, prompt: string): Promise<Verdict> {
  const { object } = await generate({ system, prompt, schema: binaryScore });
  return { pass: object.score === "yes", reason: object.reason };
}

/** `grade_generation_v_documents` — is the answer IN the documents? */
export async function gradeGrounded(
  generate: GenerateFn,
  docs: readonly Doc[],
  answer: string,
): Promise<Verdict> {
  const facts = docs.map(formatDoc).join("\n\n");
  return await grade(generate, GROUNDED_SYSTEM, `Facts:\n\n${facts}\n\nAnswer: ${answer}`);
}

/** `grade_generation_v_question` — grounded is not the same as useful. */
export async function gradeUseful(
  generate: GenerateFn,
  question: string,
  answer: string,
): Promise<Verdict> {
  return await grade(generate, ANSWERS_SYSTEM, `Question: ${question}\n\nAnswer: ${answer}`);
}
