// Copyright 2026 the AAI authors. MIT license.
/**
 * A WORKFLOW APP — the worked example for `workflowApp()`.
 *
 * Its front door is a form, not a microphone. There is no session, no
 * WebSocket, and no voice pipeline: the page (`client.tsx`) starts a run over
 * the workflow HTTP API and watches it, and the run outlives the tab.
 *
 * ## What makes this a different KIND of agent from `research-workflow`
 *
 * `research-workflow` is a voice agent that HANDS OFF to a workflow — a caller is on
 * the line, so a tool starts a run and answers the turn. Here the workflow is
 * the entire product, and the declaration says so:
 *
 * - `workflowApp()` is `agent({ …, page: "static" })` with the discriminant
 *   already set. The declaration is not decoration: `createRuntimeServer` declines
 *   `/websocket` with a reason (so a page mounted with `mountClient()` by mistake
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
 * ## What it needs
 *
 * `ASSEMBLYAI_API_KEY` in the agent env — `.env` under `aai dev`, `aai secret
 * put ASSEMBLYAI_API_KEY` once deployed — because the run really reads the page
 * and really summarizes it with a model. `requiredEnv` below is what makes a
 * deploy check for it rather than letting the first run find out, and it is
 * load-bearing here in a way it is not for a voice agent: a workflow app
 * declares no providers, so nothing else in its config names a credential.
 *
 * A step is handed no `ToolContext`, so it reads that key with `requireStepEnv`
 * rather than `ctx.env`; see `workflows/digest.ts` and `research-workflow`'s module
 * doc for the one thing that changes under `aai dev` (the key has to be in
 * `.env`, not just your shell).
 *
 * Runs are DURABLE on the platform with nothing to configure — a deployed app's
 * runs live on the platform's own database and survive a restart, a redeploy and
 * an idle sandbox.
 *
 * A `DATABASE_URL` (a secret when deployed, `.env` under `aai dev`) still buys
 * one thing here: the correlation-key index, which is what lets `find()` resolve
 * a run by key. Without one that index is in memory, so it is forgotten on a
 * restart even though the runs themselves are not. Under `aai dev` with no
 * `DATABASE_URL` the runs go too — fine while you are building.
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
  description: "Read a link, reduce it to a headline and three points, then file the digest",
  input: z.object({
    url: z.url().describe("The link to digest"),
  }),
  run: digestFlow,
});

export default workflowApp({
  name: "Link Digest",
  // The whole product. A workflow app is an agent whose work happens here.
  workflows: { digest },
  // Checked at deploy time. A workflow app declares no providers, so this is the
  // only thing that can name the credential its steps read.
  requiredEnv: ["ASSEMBLYAI_API_KEY"],
});
