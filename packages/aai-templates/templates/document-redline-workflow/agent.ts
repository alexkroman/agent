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
 * `ASSEMBLYAI_API_KEY` in the agent env — `.env` under `aai dev`, `aai secret
 * put ASSEMBLYAI_API_KEY` once deployed — which `workflowApp()` declares as
 * `requiredEnv` for you, so a deploy checks for it. Nothing for durability: a
 * deployed app's runs live on the platform.
 */

import { workflow, workflowApp } from "@alexkroman1/aai";
import { z } from "zod";
import { MAX_DRAFT_CHARS, MIN_DRAFT_CHARS, redlineFlow } from "./workflows/redline.ts";

/** The most rounds one run may spend. Their `should_continue` cap, as an input:
 *  the critic can stop earlier, and nothing can go past this. */
export const MAX_ROUNDS = 3;

/**
 * The input schema, named so the body can take `WorkflowInputOf<typeof
 * redlineInput>` and a spec can convert it.
 *
 * It is doing three jobs at once here, which is the thing to notice. It
 * validates at `start()`, so a `rounds: 40` is a 400 at the call site rather
 * than forty model calls discovered on the bill; it is served on
 * `GET /workflows` as JSON Schema, which is what lets `<WorkflowFields>` render
 * the whole form without the page naming a field; and it is the type the body
 * reads.
 *
 * **Two of its properties are deliberately not scalars, and `<WorkflowFields>`
 * still renders both.** `mustCover` is an array of strings, which renders as a
 * textarea taking one entry per line; `source` is an object of exactly
 * `{ name, text }`, which renders as a file picker that reads the chosen file
 * in the browser and contributes its name beside its text. Those are the two
 * non-scalar shapes with an honest generic control; anything else the page
 * would have to write by hand inside the same `<Form>`.
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
    .describe("Points the piece must cover, one per line"),
  // An OBJECT, so the file's name travels beside its text and the run can
  // narrate what it is marking up. A draft is a few kilobytes of prose and
  // belongs in the run's INPUT, journaled with everything else — not an
  // upload, which is the other case and `transcription-workflow`'s.
  source: z
    .object({
      name: z.string().min(1).max(200),
      text: z.string().min(MIN_DRAFT_CHARS).max(MAX_DRAFT_CHARS),
    })
    .optional()
    .describe("A draft to redline, instead of writing one from the brief"),
});

/** The declaration: schema, description, and the body. */
export const redline = workflow({
  description: "Write a piece from a brief, then critique and revise it until it is worth shipping",
  input: redlineInput,
  run: redlineFlow,
});

export default workflowApp({
  name: "Redline",
  listing: "Takes a brief or a draft and returns a piece that has been through rounds of critique",
  workflows: { redline },
});
