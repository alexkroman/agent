// Copyright 2026 the AAI authors. MIT license.
/**
 * A WORKFLOW APP that audits a recorded call, with **ffmpeg in the pipeline on
 * both sides of the model.**
 *
 * ```text
 *   any recording  →  levelled PCM  →  cut at the pauses  →  transcript
 *                        ffmpeg            ffmpeg               sync STT
 *
 *                  →  headline, risks, actions  →  a script  →  an MP3
 *                          LLM Gateway              schema      TTS + ffmpeg
 * ```
 *
 * ## Which template to read first
 *
 * This one is the deepest of the workflow apps, so it is the wrong place to start.
 *
 * - `link-digest-workflow` owns the SHAPE — `workflowApp()`, no session, no tools, a form
 *   that starts a run and a page that watches it.
 * - `transcription-workflow` owns the FAN-OUT — why the sync transcription
 *   endpoint's 120-second cap forces one, and how a run survives dying on segment
 *   27 of 60.
 * - `spoken-summary-workflow` owns the audio ROUND TRIP — `stepSpeak`, `stepWriteUpload`, and
 *   why a page needs `api.download` rather than a URL.
 *
 * **What this template adds is a decoder**, and everything downstream changes
 * because of it. `workflows/audit.ts` carries the table comparing it against
 * `transcription-workflow` row by row; the summary is that normalizing FIRST lets
 * the desk cut a recording *in its pauses* instead of every 90 seconds, which
 * deletes the segment overlap, the seam-matching stitcher, the WAV header parser
 * and one of the two provider caps it had to plan against.
 *
 * ## Five ffmpeg jobs, and each one is a decision
 *
 * `workflows/media.ts` is where they are built, and it is the file to read: every
 * argv is a pure function, so the argv is a value a spec asserts on rather than a
 * string embedded in a step that spawns.
 *
 * | | what it does | why it is not obvious |
 * | --- | --- | --- |
 * | `ffprobe` | what the file WAS | on a temp file, because a pipe cannot seek an m4a's trailing index |
 * | `loudnorm` pass 1 | measure five numbers | `-f null -`: decode everything, write nothing |
 * | `loudnorm` pass 2 | apply them | one linear gain, so speech does not pump |
 * | `silencedetect` | find every pause | same pass as above — a filter chain, not a second decode |
 * | `libmp3lame` | master the summary | 4.3 MB of WAV becomes ~110 KB |
 *
 * The two analyses read their answers back by **different routes**, and that is the
 * single most surprising thing in the template: loudness arrives on stderr (one
 * block, printed last, so the SDK's capped stderr TAIL holds it) and the pauses
 * arrive in a FILE (one event per pause, so a tail would silently drop the
 * earliest ones and the desk would mis-cut only long recordings). `media.ts`'s
 * module doc carries it.
 *
 * ## What it needs
 *
 * - **`ASSEMBLYAI_API_KEY` in the agent env** — `.env` under `aai dev`,
 *   `aai secret put ASSEMBLYAI_API_KEY` once deployed. It is `workflowApp()`'s
 *   default `requiredEnv`, so a deploy checks for it; one key covers
 *   transcription, the model and the voice alike. (ffmpeg cannot be declared
 *   there: a binary on `PATH` is not an environment variable.)
 * - **ffmpeg** — every deployed guest's image installs it (and `ffprobe` with it).
 *   Under `aai dev` it is whatever is on `PATH`, or what `AAI_FFMPEG_PATH` /
 *   `AAI_FFPROBE_PATH` name. That is the one place dev/prod parity is partial, so
 *   a missing binary is reported as an instruction rather than as
 *   `spawn ffmpeg ENOENT`.
 *
 * ## It is scriptable, which is the other half of having an API
 *
 * The page is one caller. Two requests do the same thing from a shell — upload,
 * then start a run naming the id, with `wait` holding the request open:
 *
 * ```sh
 * ID=$(curl -s -X POST "https://<your-agent>/workflows/uploads?name=call.m4a" \
 *   -H 'content-type: audio/mp4' --data-binary @call.m4a | jq -r .id)
 *
 * curl -X POST https://<your-agent>/workflows/runs \
 *   -H 'content-type: application/json' \
 *   -d "{\"workflow\":\"audit\",\"wait\":60000,\"input\":{\"recording\":\"$ID\"}}"
 * ```
 *
 * The spoken audit comes back as an upload id in the run's output; the byte route
 * (`GET /workflows/uploads/<id>`) takes the same bearer every other route does.
 */

import { workflow, workflowApp } from "@alexkroman1/aai";
import { ASSEMBLYAI_TTS_VOICES } from "@alexkroman1/aai/tts";
import { z } from "zod";
import { auditFlow } from "./workflows/audit.ts";

/**
 * The voices the form offers: the SDK's library voices, as the tuple `z.enum`
 * takes. READ from the catalog rather than listed, because a wrong voice id is
 * refused when the synthesis socket opens. Every library voice speaks every
 * supported language, so none needs filtering out.
 */
const VOICES = ASSEMBLYAI_TTS_VOICES;

/**
 * The run input. Named so the body can take `WorkflowInputOf<typeof auditInput>`
 * — the schema's own output.
 */
export const auditInput = z.object({
  // A plain string, because an upload id is what the run really receives. What
  // makes it a file picker rather than a text box is the `uploads` line below.
  //
  // "Anything" is not marketing: the first step hands the file to ffmpeg, so the
  // accepted set is ffmpeg's rather than this template's — a video's audio track
  // included, since the conversion drops the video.
  recording: z.string().describe("Any recording — WAV, MP3, M4A, or a video's audio track"),
  // An enum, so the form renders a SELECT rather than a text box — which is the
  // whole reason the list is derived above rather than left free-form. Optional,
  // so the SDK's own default voice applies when nobody chooses.
  voice: z.enum(VOICES).optional().describe("Voice to read the audit in"),
});

/**
 * The declaration: schema, description, and the body.
 *
 * Exported so `WorkflowOutputOf<typeof audit>` names the output type in one place —
 * including from `client.tsx`, where `import type` is erased and so bundles nothing
 * server-side.
 */
export const audit = workflow({
  description: "Level a call recording, transcribe it at its pauses, and audit what was said",
  input: auditInput,
  // The one line that makes the form take a file: `<WorkflowFields>` renders a
  // picker for this property, `useWorkflowSubmit` stores the chosen file, and the
  // ingest step reads it back with `stepReadUpload`.
  uploads: ["recording"],
  run: auditFlow,
});

export default workflowApp({
  name: "Call Audit",
  description:
    "Turns a recorded call into a written and spoken audit — headline, risks and follow-up actions",
  workflows: { audit },
});
