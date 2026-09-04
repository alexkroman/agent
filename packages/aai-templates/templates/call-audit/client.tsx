// Copyright 2026 the AAI authors. MIT license.
/**
 * The page: a form, a progress log, the audit, and a player.
 *
 * `link-digest` shows these primitives raw, `transcription-workflow` shows the form
 * layer in full, and `spoken-summary` shows how a page plays a file the RUN
 * produced. None of that is restated here — this page is deliberately the least
 * novel file in the template, because the subject is the pipeline.
 *
 * Two things it does add, and both are about being honest about the pipeline:
 *
 * - **The PIPELINE panel.** A reader cannot tell from a transcript whether the desk
 *   cut it in the pauses or fell back to cutting by arithmetic, and that difference
 *   is exactly what explains a mangled word at a seam. So `blindCuts` is rendered
 *   rather than hidden, alongside what the recording measured before levelling.
 * - **`useDownloadUrl`, not a URL.** The run's output carries an upload id. The
 *   obvious `<audio src={`/workflows/uploads/${id}`}>` is wrong in a way that only
 *   shows up after a deploy: the byte route takes the same `Authorization` header
 *   every other route does, and neither `<audio src>` nor `<a href>` can send one.
 *   So a page built on a URL works against `aai dev`, where there is no token, and
 *   401s the moment the agent has one. The hook is `aai-ui`'s rather than four
 *   lines here, because the two lines that matter are the ones around them: the
 *   `URL.revokeObjectURL` on cleanup, and the guard that stops a slow first
 *   download landing under a second run's output.
 *
 * ## A reload here costs the UPLOAD as well as the run
 *
 * A `runId` names a run for as long as something holds it, and this page held it
 * in React state — so a refresh lost it while the desk carried on decoding,
 * cutting and auditing. On this template that is the most expensive orphaning
 * in `templates/`: the recording is already stored, so the work is paid for, and
 * a page with no handle on it invites somebody to upload a 700 MB call a second
 * time and run the whole pipeline again. The handle that survives a reload is a
 * correlation KEY, and this desk passes none: `useWorkflowSubmit` mints one,
 * records every run under it, and asks for that key's newest run as it mounts.
 *
 * The upload half of a reload is the same hook's: it remembers the id it
 * minted, so picking the same file again sends only the windows that did not
 * land. Both halves therefore have the same LIFETIME — `sessionStorage`, one
 * store — which is the first reason this desk wants the default rather than a
 * key of its own. A handle that outlived it would promise a return the other
 * half cannot keep.
 *
 * ## Why the artifact being shareable does NOT make the key shareable
 *
 * This is the template where a `?key=` parameter is most tempting: what a run
 * produces is an audit somebody wants to send a colleague, and a URL is how
 * people send things. Weigh what the parameter would actually hand over, though,
 * because there is no per-user filtering behind `find` — the key IS the access
 * control, so anyone holding it gets, on this agent:
 *
 * - the full TRANSCRIPT of a recorded call, plus the risks and actions somebody
 *   had audited out of it,
 * - the audio, which is a real person's voice, recorded with consent to record
 *   and not consent to circulate,
 * - `cancel()` and `wake()` on a live run, and
 * - every other run this desk has filed under the same key, not just the one
 *   that was shared.
 *
 * And a URL leaks by ordinary use: pasted into a chat, kept in history, sent as
 * a referrer to whatever the page links out to. Against that, sharing the ARTIFACT
 * needs none of it — the page renders the audit and offers `Download audit.mp3`,
 * so a person sends the file and the findings deliberately, to exactly who they
 * meant. A shareable key would trade a deliberate send for an accidental one, on
 * the most sensitive input any template here accepts. The default key stays in
 * `sessionStorage`, which covers the reload this section is about and dies with
 * the tab.
 *
 * A key derived from the recording would be worse still: two desks auditing one
 * call would recover each other's runs.
 */

import "@alexkroman1/aai-ui/styles.css";
// ERASED at build time, so naming the agent's own type costs the browser bundle
// nothing — and it is what stops this file restating a shape `workflows/audit.ts`
// already declares.
import { formatBytes, formatDuration } from "@alexkroman1/aai/utils";
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
import type { audit } from "./agent.ts";

/**
 * The workflow's name, as a page starts a run by one.
 *
 * A rename in `agent.ts` is a runtime 400 rather than a compile error, which is why
 * `agent.test.ts` pins this string.
 */
const WORKFLOW = "audit";

/**
 * Hoisted out of the component deliberately.
 *
 * The hooks hold the client in a ref precisely so a fresh object per render cannot
 * restart their watch, but building one in render is still a new `fetch` closure
 * every time and reads as though it were free.
 */
const api = createWorkflowApi();

/**
 * What the desk says while a run is in flight — three situations, one line
 * each.
 *
 * The reload case gets its own words deliberately: somebody who did not press
 * the button is owed an explanation for an audit appearing in front of them,
 * and it is the line that keeps them from uploading the call again.
 */
function pendingNote(startedHere: boolean, found: boolean): string {
  if (startedHere) return "Reloading is safe — this page will find the audit again.";
  if (!found) return "Looking for an audit this tab started earlier…";
  return "Still auditing a call this tab uploaded earlier — no need to send it again.";
}

/** One labelled number in the pipeline panel. */
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <dt className="text-xs uppercase tracking-wide opacity-60">{label}</dt>
      <dd className="text-sm">{value}</dd>
    </div>
  );
}

export function App() {
  // The generic is what makes `run.status === "completed"` narrow to a TYPED
  // `run.output` instead of `unknown`. The reload — both halves of it — is the
  // hook's own doing; see the module doc for why the key it mints is the one
  // this desk wants.
  const { submitForm, run, pending, upload, pauseUpload, resumeUpload, error, startedHere } =
    useWorkflowSubmit<typeof audit>(WORKFLOW, { api });
  const output = run?.status === "completed" ? run.output : undefined;
  // `useDownloadUrl` is the SDK's: the byte route takes the agent's bearer, so the
  // bytes have to be FETCHED and handed to the element as an object URL — and the
  // object URL has to be revoked, which is the half a page written by hand forgets.
  const audio = useDownloadUrl(output?.audio, { api });

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-medium">Call Audit</h1>
        <p className="text-sm opacity-70">
          Upload a call recording — any format. It comes back levelled, transcribed at its pauses,
          and audited for risks and actions.
        </p>
      </header>

      <Form onSubmit={(values) => submitForm(values)} error={error} className="flex flex-col gap-4">
        {/* Every control, from the workflow's own input schema. See the module doc. */}
        <WorkflowFields workflow={WORKFLOW} />
        <SubmitButton pending={pending} pendingLabel="Auditing…">
          Audit the call
        </SubmitButton>
      </Form>

      {/* `pending` covers the RUN rather than the request, and on a reload it is
          also true while the run is being looked up by key — the stretch where
          an empty form would invite a second 700 MB upload of the same call. */}
      {pending && (
        <p className="text-sm opacity-70">{pendingNote(startedHere, run !== undefined)}</p>
      )}

      {/* The upload is its own wait, and the one nothing else can describe: the run
          does not EXIST until the bytes are in, so there is no run id and nothing
          for `<WorkflowProgress>` to read. */}
      <UploadProgressBar upload={upload} onPause={pauseUpload} onResume={resumeUpload} />

      {/* What the run itself says, from `stepReport()` in the workflow's steps — which
          for this template is the ffmpeg narration: what the file was, what it
          measured, how many pauses were found. */}
      <WorkflowProgress runId={run?.runId} api={api} />

      {/* `role="alert"`, the same contract `<Form>` gives the submit error: this
          is the outcome the reader waited minutes for. */}
      {run?.status === "failed" && (
        <p role="alert" className="text-red-600">
          That one failed: {run.error}
        </p>
      )}

      {output !== undefined && (
        <article className="flex flex-col gap-6">
          <div className="flex flex-col gap-1">
            <h2 className="text-xl">{output.headline}</h2>
            <Facts
              items={[output.source, formatDuration(output.durationMs), `${output.words} words`]}
            />
          </div>

          {/* What the pipeline did, which is this template's subject. Rendered rather
              than logged because `blindCuts` is the one number that explains a bad
              seam, and a reader has no other way to know. */}
          <dl className="grid grid-cols-2 gap-3 rounded border border-current/10 p-4 sm:grid-cols-3">
            <Stat label="Source codec" value={output.codec} />
            <Stat label="Loudness in" value={`${output.loudnessBefore} LUFS`} />
            <Stat label="Speech" value={`${output.speechPercent}%`} />
            <Stat label="Segments" value={String(output.segments)} />
            <Stat
              label="Cut in speech"
              value={output.blindCuts === 0 ? "none" : String(output.blindCuts)}
            />
            <Stat label="Run time" value={formatDuration(output.elapsedMs)} />
          </dl>

          {/* Either list can come back empty — see `risks` in the schema — and
              `<BulletList>` renders nothing at all when it does, heading
              included, rather than a stray heading over an empty box. */}
          <BulletList title="Risks" items={output.risks} />
          <BulletList title="Actions" items={output.actions} />

          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium opacity-70">
              Read aloud · {formatDuration(output.audioDurationMs)} ·{" "}
              {formatBytes(output.audioBytes)}
            </h3>
            {audio.pending && <p className="text-sm opacity-70">Fetching the audio…</p>}
            {audio.error !== undefined && (
              <p role="alert" className="text-red-600">
                Could not load the audio: {audio.error}
              </p>
            )}
            {audio.url !== undefined && (
              <>
                {/* No `<track>`, and that is a judgement rather than an
                    oversight: the spoken text is rendered in full immediately
                    below this player, which is the same information a caption
                    track would carry. `spoken-summary` serves a one-cue WebVTT
                    data URL instead — worth reading for how, if a real track is
                    what a page needs. */}
                <audio aria-label="Audit read aloud" controls src={audio.url} className="w-full" />
                {/* `download` works on an object URL because the bytes are already in
                    the tab; it is the href that could not carry the agent's bearer,
                    not the attribute. */}
                <a href={audio.url} download="audit.mp3" className="text-sm underline">
                  Download audit.mp3
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

page({ name: "Call Audit", component: App });
