// Copyright 2026 the AAI authors. MIT license.
/**
 * A WORKFLOW APP whose front door is an UPLOAD FORM.
 *
 * `link-digest` is the template to read first: it owns the shape — `page:
 * "static"`, no session, no tools, a form that starts a run and a page that
 * watches it — and none of that is restated here. What this one adds is the two
 * things a real job-submission app needs and a one-field form does not:
 *
 * 1. **A file.** The page's `<FileField>` contributes a `{ name, type, size }`
 *    object, which is exactly what `upload` declares below, so the collected
 *    form values ARE the run input with no mapping in between. Note what it does
 *    NOT contribute: the bytes. A workflow's input is journaled and replayed on
 *    every resume, so a recording belongs in storage with its key in the input —
 *    that is the one seam a production version of this template has to fill in.
 * 2. **A webhook.** `workflows/transcribe.ts` submits the job to a transcription
 *    provider, PARKS, and is brought back by an HTTP callback — the shape of
 *    every real asynchronous API, and the thing a durable workflow exists for.
 *
 * ## The schema is the form
 *
 * `<WorkflowFields>` renders one control per SCALAR property of the input schema
 * it reads from `GET /workflows`, so `requestedBy` and `redact` exist on the page
 * because they are declared here, and `.describe()` is what labels them. The
 * `upload` property is an object, which has no honest default control, so the
 * page writes that field itself. Both live in the same `<Form>`, because every
 * field in `@alexkroman1/aai-ui` is a plain named control.
 *
 * ## It is scriptable, which is the other half of having an API
 *
 * The page is one caller. `wait` makes the same route synchronous for the rest:
 *
 * ```sh
 * curl -X POST https://<your-agent>/workflows/runs \
 *   -H 'content-type: application/json' \
 *   -d '{"workflow":"transcribe","wait":30000,"input":{
 *        "upload":{"name":"standup.m4a","type":"audio/mp4","size":812000},
 *        "requestedBy":"alex","redact":true}}'
 * ```
 *
 * Requires storage (`aai storage enable`, or `DATABASE_URL` under `aai dev`) —
 * runs live there.
 */

import { agent, workflow } from "@alexkroman1/aai";
import { z } from "zod";
import { transcribeFlow } from "./workflows/transcribe.ts";

/**
 * The declaration: schema, description, and the directive body.
 *
 * Exported so `WorkflowOutputOf<typeof transcribe>` names the output type in one
 * place — including from `client.tsx`, where `import type` is erased and so
 * bundles nothing server-side.
 */
export const transcribe = workflow({
  description: "Transcribe an uploaded recording and file the transcript",
  input: z.object({
    // An OBJECT property, so `<WorkflowFields>` skips it and the page writes the
    // `<FileField>` that fills it. Its shape is exactly what that field
    // contributes, which is what lets the page submit its values unmapped.
    upload: z.object({
      name: z.string().min(1),
      type: z.string(),
      size: z.number().int().positive(),
    }),
    requestedBy: z.string().min(1).describe("Who the transcript is filed under"),
    redact: z.boolean().default(false).describe("Mask emails and phone numbers in the transcript"),
  }),
  run: transcribeFlow,
});

export default agent({
  name: "Transcription Desk",
  // Served by `GET /client-config`, so the page's title and empty state come
  // from the same place a voice agent's shell does.
  greeting: "Upload a recording and I will file its transcript.",
  systemPrompt: "Transcribe recordings and file the results.",

  workflows: { transcribe },

  // The front door is a form. See `link-digest`'s module doc for what this
  // really switches off, which is more than it advertises.
  page: "static",
});
