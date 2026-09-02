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
 * The BODY stays in `workflows/research.ts` by CONVENTION rather than by
 * mechanism — nothing scans that directory any more, and a body reached with a
 * `ctx` is durable wherever it is written. Keeping it there is what makes the
 * declaration, the tools and the body findable from one another.
 */

import { workflow } from "@alexkroman1/aai";
import { z } from "zod";
import { researchFlow } from "./workflows/research.ts";

/**
 * The declaration: schema, description, and the directive body.
 *
 * Exported so a client page could derive its output type with `WorkflowOutputOf`.
 */
export const research = workflow({
  description:
    "Research a topic properly — brief, angles, web search per angle, a gap pass, then a written report",
  input: z.object({
    topic: z.string().min(3).describe("What to research"),
    requestedBy: z.string().describe("Who asked — used when filing the result"),
  }),
  run: researchFlow,
});
