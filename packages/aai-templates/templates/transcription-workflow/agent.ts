// Copyright 2026 the AAI authors. MIT license.
/**
 * A WORKFLOW APP that really transcribes: point it at a recording and it comes
 * back with the text.
 *
 * `link-digest` is the template to read first: it owns the shape —
 * `workflowApp()`, no session, no tools, a form that starts a run and a page
 * that watches it — and none of that is restated here. What this one adds is a
 * workflow that does real, rate-limited, provider-shaped work:
 * `workflows/transcribe.ts` splits the recording into pieces the sync API will
 * accept, transcribes every piece in its own step, and stitches the results back
 * together. Its module doc is where the argument lives.
 *
 * ## What it needs
 *
 * - **`ASSEMBLYAI_API_KEY` in the agent env** — `.env` under `aai dev`,
 *   `aai secret put ASSEMBLYAI_API_KEY` once deployed. `requiredEnv` below is
 *   what makes a deploy check for it rather than letting the first run find out.
 *   A step reads it with `requireStepEnv`; see `@alexkroman1/aai/utils`.
 * - **Storage** (`aai storage enable`, or `DATABASE_URL` under `aai dev`) — runs
 *   live there.
 * - **A linear-PCM WAV.** The cutting is arithmetic over byte offsets, which is
 *   only possible on uncompressed audio; `workflows/wav.ts` says so in more
 *   detail, and an unsupported file fails the run by name with the `ffmpeg`
 *   line that fixes it.
 *
 * ## The recording is UPLOADED, and the run carries its id
 *
 * A workflow's input is journaled and replayed on every resume, so a
 * recording's BYTES cannot live in it — they would be re-read for the life of
 * the run, and the run API's own body cap is 64 KB besides. So the file goes to
 * `POST /workflows/uploads` (the browser does this for you: `uploads` below is
 * what makes `<WorkflowFields>` render a file picker, and `useWorkflowSubmit`
 * stores the file before starting the run), the input carries the returned id,
 * and each step reads exactly the window it needs with `readUpload` — which is
 * what keeps sixty steps from moving the same recording sixty times.
 *
 * None of that is this template's code. Uploads are the SDK's, for the reason
 * every workflow app hits this wall on its first form.
 *
 * ## It is scriptable, which is the other half of having an API
 *
 * The page is one caller. Two requests do the same thing from a shell — upload,
 * then start a run naming the id `wait` holds open until it finishes:
 *
 * ```sh
 * ID=$(curl -s -X POST "https://<your-agent>/workflows/uploads?name=standup.wav" \
 *   -H 'content-type: audio/wav' --data-binary @standup.wav | jq -r .id)
 *
 * curl -X POST https://<your-agent>/workflows/runs \
 *   -H 'content-type: application/json' \
 *   -d "{\"workflow\":\"transcribe\",\"wait\":30000,\"input\":{
 *        \"recording\":\"$ID\"}}"
 * ```
 */

import { workflow, workflowApp } from "@alexkroman1/aai";
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
  description: "Transcribe a recording by splitting it into chunks the sync API accepts",
  // ONE field, and the form is exactly as long as the schema — which is the
  // reason `client.tsx` has no field markup in it. A language picker used to sit
  // beside this and is gone: the model detects the language, so the control was
  // asking a person to answer a question the service answers better.
  input: z.object({
    // A plain string, because an upload id is what the run really receives. What
    // makes it a file picker rather than a text box is the `uploads` line below.
    recording: z.string().describe("A linear-PCM WAV recording (16-bit or 8-bit, any rate)"),
  }),
  // The one line that makes the form take a file: `<WorkflowFields>` renders a
  // picker for this property, `useWorkflowSubmit` stores the chosen file, and
  // the steps read it back with `readUpload`.
  uploads: ["recording"],
  run: transcribeFlow,
});

export default workflowApp({
  name: "Transcription Desk",
  workflows: { transcribe },
  // Checked at deploy time, so a missing key is a warning naming it rather than
  // a run that fails on its second step.
  requiredEnv: ["ASSEMBLYAI_API_KEY"],
});
