// Copyright 2026 the AAI authors. MIT license.
/**
 * The workflow DECLARATION, in a module both `agent.ts` and every tool can
 * import.
 *
 * It lives here rather than in `agent.ts` because all four tools name it —
 * `ctx.workflows.start(research, …)` takes the definition itself rather than its
 * name, which is what types the input and makes a typo a compile error instead of
 * a rejected promise the model reads as a tool failure. A tool is its own file,
 * so "both halves import the declaration" needs the declaration to have a home
 * that is neither half.
 *
 * `deepResearchWorkflow()` returns an ordinary `workflow()` definition — the
 * whole brief → angles → researchers → gaps → report pass, durable and
 * narrated — so what is written here is only what this desk decides: who the
 * brief and summary are for (`workflows/prompts.ts`) and what happens to the
 * report once it is written (`workflows/research.ts`: a review wait, then
 * filing). The researcher keeps the keyless `web_search`/`visit_webpage`
 * default and the default budget.
 */

import { deepResearchWorkflow } from "@alexkroman1/aai/experimental";
import { z } from "zod";
import { BRIEF_SUMMARY_SYSTEM, BRIEF_SYSTEM } from "./workflows/prompts.ts";
import { deliverResearch } from "./workflows/research.ts";

/**
 * The declaration: schema, description, the two prompt overrides and delivery.
 *
 * Exported so a client page could derive its output type with `WorkflowOutputOf`.
 */
export const research = deepResearchWorkflow({
  description:
    "Research a topic properly — brief, angles, web search per angle, a gap pass, then a written report",
  input: z.object({
    topic: z.string().min(3).describe("What to research"),
    requestedBy: z.string().describe("Who asked — used when filing the result"),
  }),
  prompts: { brief: BRIEF_SYSTEM, summary: BRIEF_SUMMARY_SYSTEM },
  deliver: deliverResearch,
});
