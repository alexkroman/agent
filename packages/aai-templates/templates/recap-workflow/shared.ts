// Copyright 2026 the AAI authors. MIT license.
/**
 * The workflow DECLARATION and the recording it defaults to, in a module both
 * `agent.ts` and the tools can import.
 *
 * It lives here rather than in `agent.ts` because four of the five tools name it:
 * `ctx.workflows.start(recap, …)` and `find(recap, …)` take the DEFINITION rather
 * than the string `"recap"`, which is what types the input against this schema and
 * makes a typo a compile error instead of a rejected promise the model reads as a
 * tool failure. A tool is its own file, so the declaration needs a home that is
 * neither the agent nor any one tool.
 *
 * The BODY stays in `workflows/recap.ts` by CONVENTION rather than by
 * mechanism — nothing scans that directory any more, and a body reached with a
 * `ctx` is durable wherever it is written. Keeping it there is what makes the
 * declaration, the tools and the body findable from one another.
 */

import { workflow } from "@alexkroman1/aai";
import { z } from "zod";
import { recapFlow } from "./workflows/recap.ts";

/**
 * What the desk works on when the caller does not name something else.
 *
 * A phone caller cannot read a URL aloud, which is the practical reason this
 * exists — and it is a real, public, documented sample file, so the template
 * transcribes something on the first call instead of asking for a URL it cannot
 * be given. A real desk replaces this with a lookup against its own recording
 * store: the caller says "yesterday's board meeting" and the tool resolves the
 * name.
 */
export const SAMPLE_RECORDING = "https://assembly.ai/wildfires.mp3";

/** The declaration: schema, description, and the directive body. */
export const recap = workflow({
  description:
    "Transcribe a recording with the batch API, poll it to completion, and write up what was said",
  input: z.object({
    url: z.url().describe("The recording to write up"),
    requestedBy: z.string().describe("Who asked — carried through to the finished recap"),
  }),
  run: recapFlow,
});
