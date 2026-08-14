/**
 * A WORKFLOW APP — LangGraph's reflection agent, as a thing you submit work to.
 *
 * `link-digest` owns the shape and is the one to read first (`workflowApp()`, no
 * session, no tools, a form that starts a run and a page that watches it), and
 * none of that is restated here. What this one is FOR is the mechanism in
 * `workflows/redline.ts`: write a piece, grade it against its brief, revise, and
 * go round again until the critic says ship or the rounds run out.
 *
 * ## Why this one is not a voice agent
 *
 * It was the first question worth answering, and the answer is arithmetic: a
 * three-round redline is up to seven long-form model calls in sequence. Nobody
 * holds a phone for that, and nothing useful can be said down the line while it
 * happens — the interesting output is a piece of prose to READ, not two
 * sentences to hear. The same test sorts the other ports in this repo:
 * `travel-concierge`, `support-line` and `plan-and-execute` all answer a caller inside a
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
 * - **Storage** (`aai storage enable`, or `DATABASE_URL` under `aai dev`) — runs
 *   live there.
 */

import { workflow, workflowApp } from "@alexkroman1/aai";
import { z } from "zod";
import { redlineFlow } from "./workflows/redline.ts";

/** The most rounds one run may spend. Their `should_continue` cap, as an input:
 *  the critic can stop earlier, and nothing can go past this. */
export const MAX_ROUNDS = 3;

/**
 * The declaration: schema, description, and the directive body.
 *
 * The input schema is doing three jobs at once here, which is the thing to
 * notice. It validates at `start()`, so a `rounds: 40` is a 400 at the call site
 * rather than forty model calls discovered on the bill; it is served on
 * `GET /workflows` as JSON Schema, which is what lets `<WorkflowFields>` render
 * most of this form without the page naming a field; and it is the type the
 * body reads.
 *
 * `mustCover` is an ARRAY, deliberately. `<WorkflowFields>` renders scalars only
 * — there is no honest control for an array — so the page writes that one field
 * by hand in the same `<Form>` and maps it on submit. That mixed shape is the
 * common case for any schema past the simplest, and this is its worked example;
 * `transcription-workflow` is the all-declared one.
 */
export const redline = workflow({
  description: "Write a piece from a brief, then critique and revise it until it is worth shipping",
  input: z.object({
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
  }),
  run: redlineFlow,
});

export default workflowApp({
  name: "Redline",
  workflows: { redline },
  // Checked at deploy time, so a missing key is a warning naming it rather than
  // a run that fails on its first step.
  requiredEnv: ["ASSEMBLYAI_API_KEY"],
});
