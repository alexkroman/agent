// Copyright 2026 the AAI authors. MIT license.
/**
 * A WORKFLOW APP — the worked example for `agent({ page: "static" })`.
 *
 * Its front door is a form, not a microphone. There is no session, no
 * WebSocket, and no voice pipeline: the page (`client.tsx`) starts a run over
 * the workflow HTTP API and watches it, and the run outlives the tab.
 *
 * ## What makes this a different KIND of agent from `research-desk`
 *
 * `research-desk` is a voice agent that HANDS OFF to a workflow — a caller is on
 * the line, so a tool starts a run and answers the turn. Here the workflow is
 * the entire product. That difference is one field:
 *
 * - `page: "static"` declares it, and the declaration is not decoration.
 *   `createServer` declines `/websocket` with a reason (so a page mounted with
 *   `client()` by mistake fails the same way in `aai dev` and in production
 *   rather than only after a deploy) and telephony defaults off.
 * - No `stt`/`llm`/`tts`, and no `tools`: nothing here talks, so there is no
 *   pipeline to configure and no model to give tools to.
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

import { agent, workflow } from "@alexkroman1/aai";
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

export default agent({
  name: "Link Digest",
  // A static agent still carries these — they are what `GET /client-config`
  // serves, so the page's title and empty state come from the same place a
  // voice agent's shell does.
  greeting: "Paste a link and I will file a digest of it.",
  systemPrompt: "Summarize links into three honest points.",

  // The whole product. A workflow app is an agent whose work happens here.
  workflows: { digest },

  // The front door is a form. See the module doc for what this really switches
  // off, which is more than it advertises.
  page: "static",
});
