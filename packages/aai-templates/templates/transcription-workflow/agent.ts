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
 *   A step reads it with `requireStepEnv`; see `@alexkroman1/aai/step`.
 * - **No database.** This used to ask for a `DATABASE_URL` and no longer does:
 *   an upload's record is a platform row and its bytes are platform storage, so
 *   the form below and every step that reads back what it stored work on a
 *   deployed app with nothing provisioned — and under `aai dev` they go in the
 *   project's `.workflow-data` directory beside the runs. Bring a database only
 *   for data of your OWN that has to outlive a run.
 * - **ffmpeg, under `aai dev` only.** A deployed guest's image installs it; on a
 *   laptop it is whatever is on `PATH` (or `AAI_FFMPEG_PATH`). The `transcribe`
 *   flow needs it for anything that is not already a linear-PCM WAV, because the
 *   cutting is arithmetic over byte offsets and that is only possible on
 *   uncompressed audio — `workflows/normalize.ts` is the conversion and
 *   `workflows/wav.ts` is why it has to happen. A WAV needs no ffmpeg at all,
 *   and `transcribeStream` never uses it: a recording that is still uploading is
 *   not something a decoder can be pointed at.
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
 * ## Three flows over one job, so they can be compared
 *
 * | | `transcribe` | `transcribeStream` | `transcribeBatch` |
 * | --- | --- | --- | --- |
 * | provider API | sync | sync | **async** |
 * | run starts | after the upload | **before** it | after the upload |
 * | client sends | `POST /uploads` | `PUT /uploads/<id>` | `POST /uploads` |
 * | shape | plan, fan out, merge | poll, fan out, merge | submit, poll, read |
 * | client hook | `useWorkflowSubmit` | `useWorkflowStream` | `useWorkflowSubmit` |
 * | accepts | **any audio** | linear-PCM WAV | **any audio** |
 * | converts first | when it must | never | not needed |
 * | segments | 7 for 10 minutes | 7 | **1** |
 *
 * The first two are the same fan-out arranged two ways, and the difference between
 * them is measured rather than claimed — see `workflows/stream.ts`, which records
 * what overlapping the upload actually saves (bounded by the transcription, not
 * proportional to the file). The third does none of that work and is what a real
 * product would probably ship; it is here because a template that only showed the
 * clever option would be hiding the simple one.
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
 *
 * The streaming flow is the same three verbs in a different order — start, then
 * upload parts, then seal — and the page renders the whole recipe under "Use the
 * API without this page". `AGENT.md` in this template is the copy a script author
 * reads.
 */

import { workflow, workflowApp } from "@alexkroman1/aai";
import { z } from "zod";
import { transcribeBatchFlow } from "./workflows/batch.ts";
import { transcribeStreamFlow } from "./workflows/stream.ts";
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
    //
    // It says "any recording" now, and that is the whole of what
    // `workflows/normalize.ts` bought: this used to name linear-PCM WAV and mean
    // it, so the desk's real front door was a sentence telling the caller to run
    // ffmpeg themselves. The cut still needs WAV — the run makes one.
    recording: z.string().describe("Any recording — WAV, MP3, M4A, or a video's audio track"),
  }),
  // The one line that makes the form take a file: `<WorkflowFields>` renders a
  // picker for this property, `useWorkflowSubmit` stores the chosen file, and
  // the steps read it back with `readUpload`.
  uploads: ["recording"],
  run: transcribeFlow,
});

/**
 * The same work, started BEFORE the recording has finished uploading.
 *
 * Declared beside `transcribe` rather than replacing it, because the two are worth
 * reading against each other: this one shows the transcript growing while the bytes
 * are still moving, and the other is the shape to understand first — three steps in a
 * straight line, with no polling.
 *
 * **The declaration is IDENTICAL, including `uploads`.** That is the point of the
 * mechanism: `recording` carries an upload id either way, and what differs is only
 * that the client CHOSE the id and `PUT` the file to it, so the id was valid before
 * the bytes were. `useWorkflowStream` is the client half; `workflows/stream.ts` is
 * the body, and it reuses this file's own `transcribeSegment` unchanged.
 */
export const transcribeStream = workflow({
  description: "Transcribe a recording while it is still uploading",
  input: z.object({
    // Still WAV, and this is the one flow where that is not a limitation to be
    // fixed: it cuts the recording while the bytes are arriving, and a partial
    // file is not something ffmpeg can transcode. `transcribe` converts because
    // it has the whole file before it plans anything.
    recording: z.string().describe("A linear-PCM WAV recording (16-bit or 8-bit, any rate)"),
  }),
  uploads: ["recording"],
  run: transcribeStreamFlow,
});

/**
 * The same work again, handed to AssemblyAI's ASYNC API instead of cut up.
 *
 * The third desk, and the one a real product would probably ship. Both flows above
 * exist because the SYNC endpoint answers inside the request and pays for it with a
 * 120-second, 40 MB cap — so a long recording has to be planned, fanned out and
 * stitched. The async API has no cap: submit a job, poll, read the text.
 *
 * It is declared here so the page can run all three over the same file and show what
 * each costs. What this one gives up is the inside of the work — the latency is the
 * provider's queue rather than a fan-out you can tune — and what it gains is
 * everything the other two spend code on, plus formats they refuse: the async API
 * takes compressed audio, so an m4a off a phone works where a WAV-only cut does not.
 *
 * `workflows/batch.ts` carries the rest, including why the wait is what makes this a
 * workflow rather than a request.
 */
export const transcribeBatch = workflow({
  description: "Transcribe a recording through the async API, polling until it is done",
  input: z.object({
    recording: z.string().describe("Any recording the async API accepts — WAV, MP3, M4A"),
  }),
  uploads: ["recording"],
  run: transcribeBatchFlow,
});

export default workflowApp({
  name: "Transcription Desk",
  workflows: { transcribe, transcribeStream, transcribeBatch },
  // Checked at deploy time, so a missing key is a warning naming it rather than
  // a run that fails on its second step.
  requiredEnv: ["ASSEMBLYAI_API_KEY"],
});
