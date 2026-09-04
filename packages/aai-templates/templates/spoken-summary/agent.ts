// Copyright 2026 the AAI authors. MIT license.
/**
 * A WORKFLOW APP that goes audio in, audio out: upload a recording and it comes
 * back with a summary you can read AND one you can listen to.
 *
 * `link-digest` is the template to read first: it owns the shape —
 * `workflowApp()`, no session, no tools, a form that starts a run and a page
 * that watches it — and none of that is restated here. `transcription-workflow`
 * owns the other half of the background: uploads, and what it costs to cut a
 * long recording up. What THIS one adds is the return trip.
 *
 * ```text
 *   a WAV  →  transcript  →  summary  →  a WAV of the summary
 *              async STT     LLM Gateway   streaming TTS
 * ```
 *
 * ## The last arrow is the one that needed the SDK to grow
 *
 * The first three are ordinary step work. The fourth was impossible until two
 * things existed, and they are what this template is the reference use of:
 *
 * - **`stepSpeak`** (`@alexkroman1/aai/step`) synthesizes from inside a step.
 *   The session TTS surface cannot be used here at all: a `TtsSession` is an
 *   event stream wired into a live pipeline's playback, with a turn tracker and
 *   barge-in behind it, and a step has no turn to be part of and has to return
 *   a VALUE.
 * - **`stepWriteUpload`** (same subpath) puts that value where a browser can reach
 *   it. A run's OUTPUT is read back as JSON, so audio cannot travel in one —
 *   the same rule that keeps a recording's bytes out of a run's INPUT, arriving
 *   at the other end of the run.
 *
 * And **`api.download(id)`** is the browser half: the run's output names an
 * upload id, and the page turns it into a `Blob` it can play and offer as a
 * file. `workflows/summarize.ts` carries the rest, including why the model is
 * asked for a spoken script as well as a bullet list.
 *
 * ## What it needs
 *
 * - **`ASSEMBLYAI_API_KEY` in the agent env** — `.env` under `aai dev`,
 *   `aai secret put ASSEMBLYAI_API_KEY` once deployed. One key covers all
 *   three services this uses: transcription, the LLM Gateway, and the voice.
 *   `requiredEnv` below is what makes a deploy check for it rather than letting
 *   the first run find out.
 * - **A `DATABASE_URL`** — a secret when deployed, `.env` under `aai dev`, and a
 *   Postgres you bring since the platform provisions none. REQUIRED here, and
 *   more so than for most workflow apps: an upload's record is a row, and this
 *   app uses uploads at BOTH ends — the recording coming in and the summary
 *   going out.
 *
 * ## The recording is UPLOADED, and the run carries its id
 *
 * A workflow's input is journaled and replayed on every resume, so a
 * recording's BYTES cannot live in it. So the file goes to
 * `POST /workflows/uploads` (the browser does this for you: `uploads` below is
 * what makes `<WorkflowFields>` render a file picker, and `useWorkflowSubmit`
 * stores the file before starting the run), the input carries the returned id,
 * and the step that needs the bytes streams them out with `stepReadUpload`.
 *
 * ## It is scriptable, which is the other half of having an API
 *
 * The page is one caller. Three requests do the whole thing from a shell —
 * upload, start a run, then fetch the summary's audio by the id the run
 * reported:
 *
 * ```sh
 * ID=$(curl -s -X POST "https://<your-agent>/workflows/uploads?name=standup.wav" \
 *   -H 'content-type: audio/wav' --data-binary @standup.wav | jq -r .id)
 *
 * OUT=$(curl -s -X POST https://<your-agent>/workflows/runs \
 *   -H 'content-type: application/json' \
 *   -d "{\"workflow\":\"spokenSummary\",\"wait\":30000,\"input\":{\"recording\":\"$ID\"}}")
 *
 * curl -s "https://<your-agent>/workflows/uploads/$(echo "$OUT" | jq -r .run.output.audio)" \
 *   -o summary.wav
 * ```
 */

import { workflow, workflowApp } from "@alexkroman1/aai";
import { ASSEMBLYAI_TTS_DEFAULT_VOICE, ASSEMBLYAI_TTS_VOICES } from "@alexkroman1/aai/tts";
import type { WorkflowDef } from "@alexkroman1/aai/workflow-api";
import { z } from "zod";
import { type SpokenSummary, spokenSummaryFlow } from "./workflows/summarize.ts";

/**
 * The voices the form offers.
 *
 * READ from the SDK's catalog rather than listed, because a wrong voice id is a
 * SILENT failure — it is a free-form string the service rejects in band after
 * the socket is open, so the synthesis simply produces nothing. Narrowed to the
 * English ones because the summary is written in the transcript's language and
 * the prompt does not translate; every voice in the catalog speaks exactly one.
 */
const VOICES = Object.entries(ASSEMBLYAI_TTS_VOICES)
  .filter(([, spec]) => spec.language === "en")
  .map(([id]) => id);

/**
 * The same list as a TUPLE, which is what `z.enum` takes.
 *
 * Destructured rather than cast: a `.map` produces an array, and
 * `as [string, ...string[]]` would be a template teaching a cast. The default
 * covers the empty case honestly — a catalog with no English voice falls back
 * to the SDK's own default rather than rendering a picker with no options.
 */
const [FIRST_VOICE = ASSEMBLYAI_TTS_DEFAULT_VOICE, ...OTHER_VOICES] = VOICES;

/**
 * The run input, as its own const.
 *
 * Named rather than inline because {@link spokenSummary} carries an explicit
 * type, and that annotation is what lets `workflows/summarize.ts` name
 * `WorkflowInputOf<typeof spokenSummary>` for its body's parameter: the body's
 * own signature would otherwise be part of what infers this declaration's type,
 * and TypeScript refuses the cycle (`TS7022`).
 */
const spokenSummaryInput = z.object({
  // A plain string, because an upload id is what the run really receives.
  // What makes it a file picker rather than a text box is the `uploads` line
  // below.
  recording: z.string().describe("A recording to summarize — WAV, MP3 or M4A"),
  // An enum, so the form renders a SELECT rather than a text box — which is
  // the whole reason the list is derived above rather than left free-form.
  // Optional, so the SDK's own default voice applies when nobody chooses.
  voice: z
    .enum([FIRST_VOICE, ...OTHER_VOICES])
    .optional()
    .describe("Voice to read the summary in"),
});

/**
 * The declaration: schema, description, and the directive body.
 *
 * Exported so `WorkflowOutputOf<typeof spokenSummary>` names the output type in
 * one place — including from `client.tsx`, where `import type` is erased and so
 * bundles nothing server-side — and so `workflows/summarize.ts` can name
 * `WorkflowInputOf<typeof spokenSummary>` for the body's parameter.
 */
export const spokenSummary: WorkflowDef<typeof spokenSummaryInput, SpokenSummary> = workflow({
  description: "Transcribe a recording, summarize it, and read the summary back as audio",
  input: spokenSummaryInput,
  // The one line that makes the form take a file: `<WorkflowFields>` renders a
  // picker for this property, `useWorkflowSubmit` stores the chosen file, and
  // the step that transcribes it reads it back with `stepReadUpload`.
  uploads: ["recording"],
  run: spokenSummaryFlow,
});

export default workflowApp({
  name: "Spoken Summary",
  workflows: { spokenSummary },
  // Checked at deploy time, so a missing key is a warning naming it rather than
  // a run that fails on its second step. A workflow app declares no providers,
  // so this is the only thing that can name the credential its steps read — and
  // this one key covers transcription, the model and the voice alike.
  requiredEnv: ["ASSEMBLYAI_API_KEY"],
});
