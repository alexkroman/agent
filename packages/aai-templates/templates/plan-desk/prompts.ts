/**
 * The planner, the executor and the replanner — and where they come from.
 *
 * **Adapted from LangGraph's plan-and-execute tutorial** (MIT,
 * <https://github.com/langchain-ai/langgraph>,
 * `docs/docs/tutorials/plan-and-execute/plan-and-execute.ipynb`), itself after
 * the Plan-and-Solve paper and BabyAGI.
 *
 * | plan-and-execute | here |
 * | --- | --- |
 * | `Plan` (pydantic, `steps: List[str]`) | {@link planSchema} |
 * | `planner` prompt | {@link PLANNER_SYSTEM} |
 * | the ReAct `agent_executor` with a search tool | {@link EXECUTOR_SYSTEM} + {@link stepActionSchema} |
 * | `Act = Union[Response, Plan]` | {@link actSchema} |
 * | `replanner` prompt | {@link REPLANNER_SYSTEM} |
 *
 * **Their `Act` is a union and this is a discriminated object, which is a real
 * difference worth knowing.** `Union[Response, Plan]` becomes a JSON Schema
 * `anyOf`, and structured-output support for `anyOf` varies by provider — a
 * model that quietly emits `{"steps": [...]}` when it meant to respond leaves a
 * plan looping. One object with a `kind` discriminant is the same decision in a
 * shape every provider constrains reliably, and the validator can then say
 * which half is missing.
 *
 * **The prompts are adapted for a caller who is listening.** Theirs plan for a
 * reader with a notebook open; a plan read down a phone has to be four or five
 * steps a person can hold in their head, and the replanner has to be told that
 * finishing early is a good outcome rather than a failure to plan thoroughly.
 * What is kept close to verbatim is the part that carries the mechanism: "do
 * not add superfluous steps", "each step has all the information needed", and
 * the replanner's "only add steps that still NEED to be done".
 */

import { z } from "zod";

/** Their `Plan`. Bounded, because a caller is listening to it read out. */
export const planSchema = z.object({
  steps: z
    .array(z.string().max(200))
    .min(1)
    .max(5)
    .describe("The steps, in order, each one a task that can be done on its own"),
});

/** Their `Act` — `Response | Plan` as one discriminated object. */
export const actSchema = z.object({
  kind: z.enum(["respond", "plan"]).describe("'respond' when the objective is met, else 'plan'"),
  response: z
    .string()
    .max(600)
    .describe("The answer for the caller, when kind is 'respond'")
    .optional(),
  steps: z
    .array(z.string().max(200))
    .max(5)
    .describe("The steps STILL to do, when kind is 'plan'")
    .optional(),
});

/** One turn of the executor's ReAct loop: search, or answer the step. */
export const stepActionSchema = z.object({
  action: z.enum(["search", "answer"]),
  query: z.string().max(120).describe("The web search to run, when action is 'search'").optional(),
  answer: z
    .string()
    .max(600)
    .describe("What the step established, when action is 'answer'")
    .optional(),
});

export const PLANNER_SYSTEM = [
  "For the given objective, come up with a simple step by step plan.",
  "The plan is individual tasks which, done in order, yield the objective.",
  "Do not add superfluous steps. Make sure each step carries all the",
  "information it needs — a step is done without seeing the others.",
  "The result of the final step is the final answer.",
  "This plan is READ ALOUD to the person who asked for it, so use four steps",
  "or fewer where you can, and write each one as a short spoken sentence.",
].join(" ");

export const EXECUTOR_SYSTEM = [
  "You are doing one step of a plan. You may search the web, or answer.",
  "Search when the step turns on a fact you do not reliably know — a price, a",
  "date, an availability, anything current. Search once, read what comes back,",
  "and search again only if it genuinely did not answer the step.",
  "Answer as soon as you can support the step; say what you found and where it",
  "came from. If searching did not settle it, say that plainly in the answer",
  "rather than inventing a result — a later step may be able to work around it,",
  "but only if it is told the truth.",
].join(" ");

export const REPLANNER_SYSTEM = [
  "You are updating a plan after a step was done.",
  "Only include steps that still NEED to be done — never repeat a step already",
  "completed. If everything the objective needs is now known, reply with",
  "kind 'respond' and the answer for the caller.",
  "Finishing early is a good outcome: if the completed steps already answer the",
  "objective, respond rather than inventing more work.",
  "The caller is on the phone, so an answer is two or three spoken sentences.",
].join(" ");

/** The caller changed their mind mid-plan — no counterpart in the notebook. */
export const REVISE_SYSTEM = [
  "You are updating a plan because the person it belongs to just changed what",
  "they want, mid-call. Their instruction wins over the original objective.",
  "Keep completed steps out of the new plan, keep any pending step their",
  "instruction does not affect, and reply with kind 'plan'.",
  "Reply with kind 'respond' only if their instruction means there is nothing",
  "left to do.",
].join(" ");
