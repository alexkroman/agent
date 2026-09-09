/**
 * The CRAG nodes' BODIES — one model call each, and nothing about routing.
 *
 * Split from `procedure.ts` when that file became an actual machine: the machine
 * there declares which node runs next, and these are what each node does. The
 * seam is worth having beyond the line count — everything here is a plain async
 * function of its arguments, so a spec can drive one directly, and the machine
 * holds no prompt text at all.
 *
 * **Every node is one `ctx.generate`, and they split into the two OVERLOADS.**
 * That split is this file's whole shape, so it is spelled with the SDK's own
 * names rather than left to inference: {@link scoreOf} is the schema overload
 * (`GenerateObjectResult<BinaryScore>` — `object` is REQUIRED, which is what
 * makes a closed question routable), and {@link textOf} is the plain one
 * (`GenerateResult` — `object` is optional and neither free-text node wants
 * one). Four of the six nodes go through the first.
 */

import type {
  GenerateFn,
  GenerateObjectResult,
  GenerateResult,
  GuardrailVerdict,
} from "@alexkroman1/aai";
import type { Doc } from "./knowledge.ts";
import { formatDoc } from "./knowledge.ts";
import {
  ANSWER_SYSTEM,
  ANSWERS_SYSTEM,
  type BinaryScore,
  binaryScore,
  DOC_GRADER_SYSTEM,
  GROUNDED_SYSTEM,
  REWRITE_SYSTEM,
} from "./prompts.ts";
import type { GradedDoc } from "./shared.ts";

/**
 * One closed question, asked with the schema that constrains it.
 *
 * The annotation is the point of the helper: the schema overload's result type
 * says `object` is there, so a caller reads `object.score` without a narrowing
 * step — and a node that dropped its `schema` would stop compiling here rather
 * than start reading `undefined` at run time.
 */
async function scoreOf(generate: GenerateFn, system: string, prompt: string): Promise<BinaryScore> {
  const result: GenerateObjectResult<BinaryScore> = await generate({
    system,
    prompt,
    schema: binaryScore,
  });
  return result.object;
}

/** The free-text overload, trimmed: `GenerateResult.object` is optional and unread here. */
async function textOf(generate: GenerateFn, system: string, prompt: string): Promise<string> {
  const result: GenerateResult = await generate({ system, prompt });
  return result.text.trim();
}

/** `grade_documents` — one closed question per document, all at once. */
export async function gradeDocuments(
  generate: GenerateFn,
  question: string,
  docs: readonly Doc[],
): Promise<GradedDoc[]> {
  return await Promise.all(
    docs.map(async (doc) => {
      const { score, reason } = await scoreOf(
        generate,
        DOC_GRADER_SYSTEM,
        `Caller's question: ${question}\n\nDocument:\n${formatDoc(doc)}`,
      );
      return { id: doc.id, title: doc.title, relevant: score === "yes", reason };
    }),
  );
}

/** `transform_query` — their question re-writer, aimed at a keyword index. */
export async function transformQuery(generate: GenerateFn, question: string): Promise<string> {
  const rewritten = (
    await textOf(generate, REWRITE_SYSTEM, `Caller's question: ${question}`)
  ).replace(/^["']|["']$/g, "");
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
  return await textOf(
    generate,
    ANSWER_SYSTEM,
    `Documents:\n\n${docs.map(formatDoc).join("\n\n")}\n\nCaller's question: ${question}`,
  );
}

/**
 * The two generation graders — same closed question, different subject.
 *
 * **Their verdict is a `GuardrailVerdict`, which is the SDK's word for exactly
 * this.** `true` accepts; anything else is the complaint, and the complaint is
 * what the next attempt is told. The local `{ pass, reason }` this replaced was
 * the `{ ok: false, reason }` shape that type's own doc argues against, and it
 * had the predicted defect: the routing read `pass` and nothing ever read
 * `reason`, so the sidebar showed a constant "not grounded" where the grader
 * had said WHY. `procedure.ts` writes the string into the trace now.
 *
 * The DOCUMENT grader keeps both fields ({@link GradedDoc}) and deliberately
 * does not convert: there the sidebar renders the reason a document PASSED too,
 * and `true` carries no sentence.
 */
async function grade(
  generate: GenerateFn,
  system: string,
  prompt: string,
): Promise<GuardrailVerdict> {
  const { score, reason } = await scoreOf(generate, system, prompt);
  return score === "yes" || reason;
}

/** `grade_generation_v_documents` — is the answer IN the documents? */
export async function gradeGrounded(
  generate: GenerateFn,
  docs: readonly Doc[],
  answer: string,
): Promise<GuardrailVerdict> {
  const facts = docs.map(formatDoc).join("\n\n");
  return await grade(generate, GROUNDED_SYSTEM, `Facts:\n\n${facts}\n\nAnswer: ${answer}`);
}

/** `grade_generation_v_question` — grounded is not the same as useful. */
export async function gradeUseful(
  generate: GenerateFn,
  question: string,
  answer: string,
): Promise<GuardrailVerdict> {
  return await grade(generate, ANSWERS_SYSTEM, `Question: ${question}\n\nAnswer: ${answer}`);
}
