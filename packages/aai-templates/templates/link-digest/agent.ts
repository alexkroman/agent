// Copyright 2026 the AAI authors. MIT license.
/**
 * A WORKFLOW APP — the worked example for `workflowApp()`.
 *
 * Its front door is a form, not a microphone. There is no session, no
 * WebSocket, and no voice pipeline: the page (`client.tsx`) starts a run over
 * the workflow HTTP API and watches it, and the run outlives the tab.
 *
 * ## What makes this a different KIND of agent from `research-desk`
 *
 * `research-desk` is a voice agent that HANDS OFF to a workflow — a caller is on
 * the line, so a tool starts a run and answers the turn. Here the workflow is
 * the entire product, and the declaration says so:
 *
 * - `workflowApp()` is `agent({ …, page: "static" })` with the discriminant
 *   already set. The declaration is not decoration: `createServer` declines
 *   `/websocket` with a reason (so a page mounted with `client()` by mistake
 *   fails the same way in `aai dev` and in production rather than only after a
 *   deploy) and telephony defaults off.
 * - There is no `stt`/`llm`/`tts`, no `tools` and no `systemPrompt` — and they
 *   are not merely omitted, they are UNDECLARABLE here. Nothing talks and no
 *   model runs, so every one of them was inert; this file used to carry a
 *   `systemPrompt` addressed to a model that never ran.
 *
 * ## What the page needs from this file, and how it gets it
 *
 * Only the workflow's NAME and its output TYPE. The name is the key in
 * `workflows` below — `"digest"` — and the type is
 * `WorkflowOutputOf<typeof digest>`, derived from a `import type` of this module
 * which is ERASED at build time, so naming it pulls no server graph into the
 * browser bundle. Nothing is generated and nothing is restated.
 *
 * Requires storage (`aai storage enable`, or `DATABASE_URL` under `aai dev`) —
 * runs and the correlation-key index both live there.
 */

import { workflow, workflowApp } from "@alexkroman1/aai";
import { z } from "zod";
import { digestFlow } from "./workflows/digest.ts";

/**
 * The declaration: schema, description, and the directive body.
 *
 * The `input` schema does double duty here in a way it cannot for a voice agent.
 * It validates at `start()` — so a bad URL is a 400 at the call site rather than
 * a failed run discovered later — and it is served on `GET /workflows` as JSON
 * Schema, which is what lets a page render a form from a workflow it was not
 * written against.
 */
export const digest = workflow({
  description: "Summarize a link, sit on it briefly, then file the digest",
  input: z.object({
    url: z.url().describe("The link to digest"),
  }),
  run: digestFlow,
});

export default workflowApp({
  name: "Link Digest",
  // The whole product. A workflow app is an agent whose work happens here.
  workflows: { digest },
});
