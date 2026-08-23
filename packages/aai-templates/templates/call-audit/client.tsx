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
 */

import "@alexkroman1/aai-ui/styles.css";
// ERASED at build time, so naming the agent's own type costs the browser bundle
// nothing — and it is what stops this file restating a shape `workflows/audit.ts`
// already declares.
import { formatBytes, formatDuration } from "@alexkroman1/aai/utils";
import type { WorkflowOutputOf } from "@alexkroman1/aai/workflow-api";
import {
  createWorkflowApi,
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

/** What a completed run reports, derived from the workflow rather than restated. */
type Audit = WorkflowOutputOf<typeof audit>;

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

/** One labelled number in the pipeline panel. */
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <dt className="text-xs uppercase tracking-wide opacity-60">{label}</dt>
      <dd className="text-sm">{value}</dd>
    </div>
  );
}

/** A list that renders nothing rather than an empty box — see `risks` in the schema. */
function Findings({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-sm font-medium opacity-70">{title}</h3>
      <ul className="flex list-disc flex-col gap-1 pl-5">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </section>
  );
}

export function App() {
  // The generic is what makes `run.status === "completed"` narrow to a TYPED
  // `run.output` instead of `unknown`.
  const { submit, run, pending, upload, pauseUpload, resumeUpload, error } =
    useWorkflowSubmit<Audit>(WORKFLOW, { api });
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

      <Form onSubmit={submit} error={error} className="flex flex-col gap-4">
        {/* Every control, from the workflow's own input schema. See the module doc. */}
        <WorkflowFields workflow={WORKFLOW} />
        <SubmitButton pending={pending} pendingLabel="Auditing…">
          Audit the call
        </SubmitButton>
      </Form>

      {/* The upload is its own wait, and the one nothing else can describe: the run
          does not EXIST until the bytes are in, so there is no run id and nothing
          for `<WorkflowProgress>` to read. */}
      <UploadProgressBar upload={upload} onPause={pauseUpload} onResume={resumeUpload} />

      {/* What the run itself says, from `report()` in the workflow's steps — which
          for this template is the ffmpeg narration: what the file was, what it
          measured, how many pauses were found. */}
      <WorkflowProgress runId={run?.runId} api={api} />

      {run?.status === "failed" && <p className="text-red-600">That one failed: {run.error}</p>}

      {output !== undefined && (
        <article className="flex flex-col gap-6">
          <div className="flex flex-col gap-1">
            <h2 className="text-xl">{output.headline}</h2>
            <p className="text-sm opacity-70">
              {output.source} · {formatDuration(output.durationMs)} · {output.words} words
            </p>
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

          <Findings title="Risks" items={output.risks} />
          <Findings title="Actions" items={output.actions} />

          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium opacity-70">
              Read aloud · {formatDuration(output.audioDurationMs)} ·{" "}
              {formatBytes(output.audioBytes)}
            </h3>
            {audio.pending && <p className="text-sm opacity-70">Fetching the audio…</p>}
            {audio.error !== undefined && (
              <p className="text-red-600">Could not load the audio: {audio.error}</p>
            )}
            {audio.url !== undefined && (
              <>
                {/* No `<track>`, and that is a judgement rather than an
                    oversight: the spoken text is rendered in full immediately
                    below this player, which is the same information a caption
                    track would carry. `spoken-summary` serves a one-cue WebVTT
                    data URL instead — worth reading for how, if a real track is
                    what a page needs. */}
                <audio controls src={audio.url} className="w-full" />
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
