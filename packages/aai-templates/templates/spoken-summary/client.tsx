// Copyright 2026 the AAI authors. MIT license.
/**
 * The page: a form, a progress log, a summary, and a player.
 *
 * `link-digest` shows these primitives raw and `transcription-workflow` shows
 * the form layer in full; neither is restated here. What this page adds is the
 * one thing a workflow app could not do before — **playing a file the RUN
 * produced.**
 *
 * ## An upload id is not a URL, and `api.download` is why
 *
 * The run's output carries `audio`, which is an upload id in the agent's own
 * store. The obvious next line is `<audio src={`/workflows/uploads/${id}`}>`,
 * and it is wrong in a way that only shows up after a deploy: the byte route
 * takes the same `Authorization` header every other route does, and neither
 * `<audio src>` nor `<a href>` can send one. So a page built on a URL works
 * against `aai dev`, where there is no token, and 401s the moment the agent has
 * one.
 *
 * `api.download(id)` reads it with the header and answers a `Blob`;
 * `URL.createObjectURL` turns that into something both elements take. The
 * object URL is REVOKED when the run changes, which is not tidiness — an object
 * URL pins its blob for the life of the document, so a page that summarized
 * five recordings would be holding five files it can no longer reach.
 *
 * ## The form is DECLARED, not written
 *
 * There is no field markup here at all. `<WorkflowFields>` renders a control
 * per property of the workflow's own input schema, read from `GET /workflows` —
 * so the file picker exists because `agent.ts` declares `recording` in
 * `uploads`, and the voice SELECT exists because it declares `voice` as an
 * enum. Adding a field there adds a control here with no edit.
 *
 * ## A reload used to lose a run whose input was already paid for
 *
 * A `runId` names a run for as long as something holds it, and this page held it
 * in React state — so a refresh lost it while the recording carried on being
 * transcribed, summarized and spoken. The bytes were already stored, so the
 * expensive half had happened; what an empty form invites is somebody uploading
 * the recording again and paying for all four legs twice. Both halves are the
 * SDK's now and this page writes neither: `useWorkflowSubmit` records the run
 * under a correlation KEY it keeps for this page and asks for it again on the
 * next load, and picking the same file again sends only the windows that did
 * not land.
 *
 * **That key is `useRunKey()`'s** — opaque, and in `sessionStorage`, which is
 * the same lifetime as the upload recall, so both halves of a reload make the
 * same promise. What it rules out is a `?key=` parameter, and it is worth being
 * plain about the trade because this template exists to produce something
 * sendable: a summary you can listen to is exactly the sort of thing somebody
 * forwards, and a URL is how people forward things. But there is no per-user
 * filtering behind `find`, so the key IS the access control — a leaked one
 * grants, on this agent, the whole TRANSCRIPT of the recording, the summary,
 * the synthesized audio, and every other run filed under the same key. And URLs
 * leak by ordinary use: chats, history, referrers. Sharing the artifact needs
 * none of that — the page offers `Download summary.wav` and renders the words,
 * so a person sends the file to exactly who they meant. Deriving the key from
 * the recording would be worse again: two people summarizing one file would
 * recover each other's runs.
 *
 * A real app with accounts passes the account's own id as `key` instead, and
 * then a summary follows the person to another device — a promise only a login
 * can keep.
 */

import "@alexkroman1/aai-ui/styles.css";
// ERASED at build time, so naming the agent's own type costs the browser bundle
// nothing — and it is what stops this file restating a shape
// `workflows/summarize.ts` already declares.
import { formatDuration } from "@alexkroman1/aai/utils";
import {
  BulletList,
  createWorkflowApi,
  Facts,
  Form,
  page,
  SubmitButton,
  UploadProgressBar,
  useDownloadUrl,
  useWorkflowSubmit,
  WorkflowFields,
  WorkflowProgress,
} from "@alexkroman1/aai-ui";
import type { spokenSummary } from "./agent.ts";

/**
 * The workflow's name, as a page starts a run by one.
 *
 * A rename in `agent.ts` is a runtime 400 rather than a compile error, which is
 * why `agent.test.ts` pins this string.
 */
const WORKFLOW = "spokenSummary";

/**
 * Hoisted out of the component deliberately.
 *
 * The hooks hold the client in a ref precisely so a fresh object per render
 * cannot restart their watch, but building one in render is still a new `fetch`
 * closure every time and reads as though it were free.
 */
const api = createWorkflowApi();

/**
 * What the page says while a run is in flight — three situations, one line
 * each.
 *
 * The reload case gets its own words deliberately: somebody who did not press
 * the button is owed an explanation for a summary appearing in front of them,
 * and it is the line that keeps them from uploading the recording again.
 */
function pendingNote(startedHere: boolean, found: boolean): string {
  if (startedHere) return "Reloading is safe — this page will find the summary again.";
  if (!found) return "Looking for a summary this tab started earlier…";
  return "Still working on a recording this tab uploaded earlier — no need to send it again.";
}

/**
 * The spoken text as a one-cue WebVTT track, inline.
 *
 * A data URL rather than another stored file: the words are already on the page
 * and the whole track is a few hundred bytes, so a second upload — and a second
 * `download` round trip to read it — would buy nothing.
 */
function captionsUrl(text: string, durationMs: number): string {
  // `hh:mm:ss.mmm`, which is the only timestamp shape WebVTT accepts.
  const end = new Date(durationMs).toISOString().slice(11, 23);
  const vtt = `WEBVTT\n\n00:00:00.000 --> ${end}\n${text}\n`;
  return `data:text/vtt;charset=utf-8,${encodeURIComponent(vtt)}`;
}

export function App() {
  // The generic is what makes `run.status === "completed"` narrow to a TYPED
  // `run.output` instead of `unknown`. The reload is the hook's own doing — see
  // the module doc for why the key it mints is the right one for this page.
  const { submitForm, run, pending, upload, pauseUpload, resumeUpload, error, startedHere } =
    useWorkflowSubmit<typeof spokenSummary>(WORKFLOW, { api });
  const output = run?.status === "completed" ? run.output : undefined;
  // `useDownloadUrl` is the SDK's: the byte route takes the agent's bearer, so the
  // bytes have to be FETCHED and handed to the element as an object URL — and the
  // object URL has to be revoked, which is the half a page written by hand forgets.
  const audio = useDownloadUrl(output?.audio, { api });

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 p-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-medium">Spoken Summary</h1>
        <p className="text-sm opacity-70">
          Upload a recording. It comes back summarized — in writing, and read aloud.
        </p>
      </header>

      <Form onSubmit={(values) => submitForm(values)} error={error} className="flex flex-col gap-4">
        {/* Every control, from the workflow's own input schema. See the module doc. */}
        <WorkflowFields workflow={WORKFLOW} />
        <SubmitButton pending={pending} pendingLabel="Working…">
          Summarize
        </SubmitButton>
      </Form>

      {/* `pending` covers the RUN rather than the request, and on a reload it is
          also true while the run is being looked up by key — the stretch where
          an empty form would invite a second upload of the same recording. */}
      {pending && (
        <p className="text-sm opacity-70">{pendingNote(startedHere, run !== undefined)}</p>
      )}

      {/* The upload is its own wait, and the one nothing else can describe: the
          run does not EXIST until the bytes are in, so there is no run id and
          nothing for `<WorkflowProgress>` to read. */}
      <UploadProgressBar upload={upload} onPause={pauseUpload} onResume={resumeUpload} />

      {/* What the run itself says, from `stepReport()` in the workflow's steps. */}
      <WorkflowProgress runId={run?.runId} api={api} />

      {/* `role="alert"`, the same contract `<Form>` gives the submit error: this
          is the outcome the reader waited minutes for. */}
      {run?.status === "failed" && (
        <p role="alert" className="text-red-600">
          That one failed: {run.error}
        </p>
      )}

      {output !== undefined && (
        <article className="flex flex-col gap-5">
          <div className="flex flex-col gap-1">
            <h2 className="text-xl">{output.headline}</h2>
            <Facts
              items={[output.source, formatDuration(output.durationMs), `${output.words} words`]}
            />
          </div>

          <BulletList items={output.points} />

          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium opacity-70">
              Read aloud · {formatDuration(output.audioDurationMs)}
            </h3>
            {audio.pending && <p className="text-sm opacity-70">Fetching the audio…</p>}
            {audio.error !== undefined && (
              <p role="alert" className="text-red-600">
                Could not load the audio: {audio.error}
              </p>
            )}
            {audio.url !== undefined && (
              <>
                <audio aria-label="Summary read aloud" controls src={audio.url} className="w-full">
                  {/* A real caption track, not a suppression: the summary was
                      written before it was spoken, so the words are already
                      here and one cue spanning the clip is an honest
                      transcript of it. */}
                  <track
                    kind="captions"
                    srcLang="en"
                    label="Summary"
                    default
                    src={captionsUrl(output.spoken, output.audioDurationMs)}
                  />
                </audio>
                {/* `download` works on an object URL because the bytes are
                    already in the tab; it is the href that could not carry the
                    agent's bearer, not the attribute. */}
                <a href={audio.url} download="summary.wav" className="text-sm underline">
                  Download summary.wav
                </a>
              </>
            )}
            <p className="text-sm opacity-70">{output.spoken}</p>
          </section>

          <details className="text-sm">
            <summary className="cursor-pointer opacity-70">Transcript</summary>
            <p className="mt-2 whitespace-pre-wrap">{output.transcript}</p>
          </details>
        </article>
      )}
    </main>
  );
}

page({ name: "Spoken Summary", component: App });
