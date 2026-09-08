/**
 * A WORKFLOW APP — LangGraph's reflection agent, as a thing you submit work to.
 *
 * `link-digest-workflow` owns the shape and is the one to read first (`workflowApp()`, no
 * session, no tools, a form that starts a run and a page that watches it), and
 * none of that is restated here. What this one is FOR is the mechanism in
 * `workflows/redline.ts`: write a piece — or take one the author attached —
 * grade it against its brief, revise, and go round again until the critic says
 * ship or the rounds run out.
 *
 * ## Why this one is not a voice agent
 *
 * It was the first question worth answering, and the answer is arithmetic: a
 * three-round redline is up to seven long-form model calls in sequence. Nobody
 * holds a phone for that, and nothing useful can be said down the line while it
 * happens — the interesting output is a piece of prose to READ, not two
 * sentences to hear. The same test sorts the other ports in this repo:
 * `travel-concierge-agent`, `technical-support-agent` and `research-planner-agent` all answer a caller inside a
 * turn, so they are voice agents; this one and `transcription-workflow` produce a
 * document, so they are pages over durable runs.
 *
 * ## What it needs
 *
 * - **`ASSEMBLYAI_API_KEY` in the agent env** — `.env` under `aai dev`,
 *   `aai secret put ASSEMBLYAI_API_KEY` once deployed. A step is handed no
 *   `ToolContext`, so it reads that key with `requireStepEnv` (inside
 *   `stepGenerate`); `requiredEnv` below is what makes a deploy check for it
 *   rather than letting the first run find out.
 * - **Nothing for durability.** A deployed app's runs live on the platform. A
 *   `DATABASE_URL` (yours, if you set one) only moves the correlation-key index
 *   out of memory.
 */

import { workflow, workflowApp } from "@alexkroman1/aai";
import { z } from "zod";
import { MAX_DRAFT_CHARS, MIN_DRAFT_CHARS, redlineFlow } from "./workflows/redline.ts";

/** The most rounds one run may spend. Their `should_continue` cap, as an input:
 *  the critic can stop earlier, and nothing can go past this. */
export const MAX_ROUNDS = 3;

/**
 * The input schema, named rather than inline so a spec can convert it.
 *
 * It is doing three jobs at once here, which is the thing to notice. It
 * validates at `start()`, so a `rounds: 40` is a 400 at the call site rather
 * than forty model calls discovered on the bill; it is served on
 * `GET /workflows` as JSON Schema, which is what lets `<WorkflowFields>` render
 * most of this form without the page naming a field; and it is the type the
 * body reads.
 *
 * **Two of its four properties are deliberately not scalars, and that is what
 * makes this the MIXED form.** `<WorkflowFields>` renders one control per SCALAR
 * property and nothing at all for the rest, so `mustCover` (an array — no honest
 * generic control) and `source` (an object) are the two the page writes by hand
 * and maps on submit. `agent.test.ts` pins that split through `fieldKindFor`,
 * the same function `<WorkflowFields>` decides with, because the failure is
 * silent in both directions: a property that starts rendering a control gets one
 * beside the hand-written field, and one that stops rendering simply vanishes.
 * `transcription-workflow` is the all-declared form.
 */
export const redlineInput = z.object({
  // Short on purpose: it renders as a one-line control, and a brief that
  // needs three paragraphs is the `mustCover` list wearing a disguise.
  brief: z.string().min(20).max(400).describe("One sentence: what to write, and why"),
  audience: z
    .enum(["general readers", "engineers", "executives", "customers"])
    .describe("Who it is for"),
  // A `z.enum` is what makes the control above a `<SelectField>` rather than a
  // text box — the form is as good as the schema is specific.
  rounds: z
    .number()
    .int()
    .min(1)
    .max(MAX_ROUNDS)
    .default(2)
    .describe("How many critique-and-revise rounds to allow"),
  mustCover: z
    .array(z.string().max(200))
    .max(6)
    .default([])
    .describe("Points the piece must cover"),
  // An OBJECT, and that shape is load-bearing twice over. It keeps the file's
  // name beside its text, so the run can narrate what it is marking up; and it
  // is what stops `<WorkflowFields>` rendering a text box over the page's own
  // `<FileField>` — a `draft: z.string()` here would produce two controls for
  // one property, the second silently overwriting the first on submit.
  source: z
    .object({
      name: z.string().min(1).max(200),
      text: z.string().min(MIN_DRAFT_CHARS).max(MAX_DRAFT_CHARS),
    })
    .optional()
    .describe("A draft to redline, instead of writing one from the brief"),
});

/** The declaration: schema, description, and the directive body. */
export const redline = workflow({
  description: "Write a piece from a brief, then critique and revise it until it is worth shipping",
  input: redlineInput,
  run: redlineFlow,
});

export default workflowApp({
  name: "Redline",
  workflows: { redline },
  // Checked at deploy time, so a missing key is a warning naming it rather than
  // a run that fails on its first step.
  requiredEnv: ["ASSEMBLYAI_API_KEY"],
});
