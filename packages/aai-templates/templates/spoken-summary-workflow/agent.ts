// Copyright 2026 the AAI authors. MIT license.
/**
 * A WORKFLOW APP that goes audio in, audio out: upload a recording and it comes
 * back with a summary you can read AND one you can listen to.
 *
 * `link-digest-workflow` is the template to read first: it owns the shape —
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
 * `ASSEMBLYAI_API_KEY` in the agent env — `.env` under `aai dev`, `aai secret
 * put ASSEMBLYAI_API_KEY` once deployed. One key covers all three services this
 * uses: transcription, the LLM Gateway, and the voice. It is `workflowApp()`'s
 * default `requiredEnv`, so a deploy checks for it. Uploads at both ends — the
 * recording in, the summary out — are platform storage with nothing to
 * provision.
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
import { ASSEMBLYAI_TTS_VOICES } from "@alexkroman1/aai/tts";
import { z } from "zod";
import { spokenSummaryFlow } from "./workflows/summarize.ts";

/**
 * The voices the form offers: the SDK's library voices, as the tuple `z.enum`
 * takes.
 *
 * READ from the SDK's catalog rather than listed, because a wrong voice id is
 * refused when the synthesis socket opens — the run fails at the step rather
 * than at the form. Every library voice speaks every supported language, so the
 * summary (written in the transcript's own language) can be read by any of them.
 *
 * Exported so `agent.test.ts` can hold the list to the catalog it came from —
 * in particular that the voice the SDK fills in for an unchosen one is on it.
 */
export const VOICES = ASSEMBLYAI_TTS_VOICES;

/**
 * The run input. Named so the body can take
 * `WorkflowInputOf<typeof spokenSummaryInput>` — the schema's own output.
 */
export const spokenSummaryInput = z.object({
  // A plain string, because an upload id is what the run really receives.
  // What makes it a file picker rather than a text box is the `uploads` line
  // below.
  recording: z.string().describe("A recording to summarize — WAV, MP3 or M4A"),
  // An enum, so the form renders a SELECT rather than a text box — which is
  // the whole reason the list is derived above rather than left free-form.
  // Optional, so the SDK's own default voice applies when nobody chooses.
  voice: z.enum(VOICES).optional().describe("Voice to read the summary in"),
});

/**
 * The declaration: schema, description, and the body.
 *
 * Exported so `WorkflowOutputOf<typeof spokenSummary>` names the output type in
 * one place — including from `client.tsx`, where `import type` is erased and so
 * bundles nothing server-side.
 */
export const spokenSummary = workflow({
  description: "Transcribe a recording, summarize it, and read the summary back as audio",
  input: spokenSummaryInput,
  // The one line that makes the form take a file: `<WorkflowFields>` renders a
  // picker for this property, `useWorkflowSubmit` stores the chosen file, and
  // the step that transcribes it reads it back.
  uploads: ["recording"],
  run: spokenSummaryFlow,
});

export default workflowApp({
  name: "Spoken Summary",
  // The listing line — a registry row, the studio's picker, `aai list`; never
  // the model, which a workflow app does not have. It names what comes OUT,
  // which is what tells this desk apart from every other one that takes audio.
  description: "Turns a recording into a written summary and an audio one you can play back",
  workflows: { spokenSummary },
});
