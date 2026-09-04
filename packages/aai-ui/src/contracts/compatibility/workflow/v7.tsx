// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-ui:workflow` epoch 7.
 *
 * A workflow app's page as it was authored at epoch 7 — pick a workflow off the
 * agent's own listing, start a run, follow it, narrate it, render its output,
 * play back the audio it stored, and offer the run's own controls. It must keep
 * compiling for as long as epoch 7 is advertised as supported.
 *
 * ## What moved, and why epoch 7 survives it
 *
 * Epoch 8 added `startedHere` to {@link WorkflowSubmission} — and therefore to
 * {@link WorkflowStreamSubmission}, which is an alias of it. Six templates had
 * kept that fact as a `useState(false)` beside the hook; the field is the hook
 * publishing what only it can know.
 *
 * A page is a READER of the submission object, so a field added to it cannot
 * break one. {@link Page} below destructures eight fields and never mentions
 * the ninth, which is exactly what an epoch-7 page did. The direction that
 * would break is a page CONSTRUCTING a `WorkflowSubmission` — a hand-written
 * fake in a page's own spec, say — and this file is careful not to imply that
 * was ever the way in: {@link summarize} takes one and reads it.
 *
 * The alias is the reason {@link StreamedPage} is here rather than being left
 * to `useWorkflowSubmit`'s example. `WorkflowStreamSubmission` is a NAME for
 * that same object, so the two hooks are drop-in siblings only for as long as
 * the alias holds — and an alias that quietly became a second declaration would
 * compile everywhere except at an annotation like that one's.
 *
 * Note what is NOT a break and looks like one: `reset()` now also clears
 * `startedHere`. An epoch-7 page that mirrored the flag by hand still compiles
 * and still behaves, because its own copy is cleared by its own handler; it is
 * merely doing work the hook now does. Behaviour-compatible, which is the bar
 * for a RETAINED epoch rather than a dropped one.
 *
 * ## The three OPTIONS types, and the four RESULT types
 *
 * Every hook on this surface takes an options bag and answers a named type, and
 * a page that passes an object literal and destructures the answer freezes
 * neither. So each is named at the call site — `UseWorkflowRunsOptions`,
 * `UseWorkflowStreamOptions`, `UseWorkflowsOptions`, `WorkflowApiOptions` on the
 * way in; `UseWorkflowRunResult`, `UseWorkflowProgressResult`,
 * `UseWorkflowsResult`, `UseDownloadUrlResult` on the way out. An options field
 * that became required, or a result field that was narrowed or removed, reddens
 * at the annotation rather than at whichever read happened to depend on it.
 *
 * The three DEF-derived types are named for the same reason and freeze
 * something else: {@link WorkflowInputOf} and {@link SubmitInputOf} disagree on
 * purpose for a def that declares no schema — `never` against `undefined`, so
 * that `submit()` stays callable — and a page's own helper is where that
 * distinction has to keep holding.
 */

import type { WorkflowDef } from "@alexkroman1/aai";
import type {
  SubmitInputOf,
  UploadStatus,
  UseDownloadUrlOptions,
  UseDownloadUrlResult,
  UseWorkflowProgressResult,
  UseWorkflowRunResult,
  UseWorkflowRunsOptions,
  UseWorkflowRunsResult,
  UseWorkflowStreamOptions,
  UseWorkflowSubmitOptions,
  UseWorkflowsOptions,
  UseWorkflowsResult,
  WorkflowApi,
  WorkflowApiOptions,
  WorkflowInputOf,
  WorkflowOutputOf,
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowStreamSubmission,
  WorkflowSubmission,
  WorkflowSummary,
} from "../../../index.ts";
import {
  createWorkflowApi,
  isTerminal,
  UploadProgressBar,
  useDownloadUrl,
  useRunKey,
  useWorkflowProgress,
  useWorkflowRun,
  useWorkflowRuns,
  useWorkflowStream,
  useWorkflowSubmit,
  useWorkflows,
  WORKFLOW_STATUS_LABELS,
  WorkflowProgress,
} from "../../../index.ts";

/**
 * The output this page's workflow produces.
 *
 * `audio` is an upload ID rather than bytes, which is the round trip
 * {@link Playback} below exists to render: a run's output is read back as JSON,
 * so audio leaves a run the way it entered one.
 */
type Digest = { headline: string; points: readonly string[]; audio?: string };

/**
 * The def the hooks take, built structurally.
 *
 * `zod` is not a dependency here, so the Standard-Schema slot the hooks read
 * (`~standard.types.output`) is written out — the same shape this package's own
 * specs use, and all a type-level def needs.
 */
type SchemaOf<O extends Record<string, unknown>> = {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => { readonly value: O };
    readonly types?: { readonly input: unknown; readonly output: O } | undefined;
  };
};
type DigestWorkflow = WorkflowDef<SchemaOf<{ url: string }>, Digest>;

/** What the def says a run of it takes, and what a completed one answers with. */
type DigestInput = WorkflowInputOf<DigestWorkflow>;
type DigestOutput = WorkflowOutputOf<DigestWorkflow>;

/**
 * The client's own options, named rather than written at the call.
 *
 * A page served by its own agent passes neither field — the defaults are the
 * page's origin and no bearer — so a page that never names the type would not
 * notice either one being narrowed. A programmatic caller written against the
 * same client is who does.
 */
const API_OPTIONS: WorkflowApiOptions = { baseUrl: "https://digest.example.test" };

/** Hoisted, so every hook on the page shares one client. */
const api: WorkflowApi = createWorkflowApi(API_OPTIONS);

/** The status line, overriding one label the way epoch 7 published. */
const STATUS_LINE: Record<WorkflowRunStatus, string> = {
  ...WORKFLOW_STATUS_LABELS,
  running: "Digesting…",
};

/**
 * A reader of the submission — the direction a field addition cannot break.
 *
 * Both type arguments are named, which is what lets it serve BOTH hooks: a
 * stream submission is an alias of this type, so a reader written against it
 * has to accept one, and it would not if the input were left at `unknown`.
 */
export function summarize(submission: WorkflowSubmission<Digest, DigestInput>): string {
  const { run, pending, error } = submission;
  if (error !== undefined) return error;
  if (run === undefined) return pending ? "Starting…" : "Idle";
  return STATUS_LINE[run.status];
}

/**
 * Start a run through the submit function the hook handed over.
 *
 * The parameter is `SubmitInputOf` and the value built for it is
 * `WorkflowInputOf`, which is the whole point of there being two: they are the
 * same type for a def that declares a schema, and they diverge for one that does
 * not — `never` would make this function uncallable where `undefined` keeps
 * `submit(undefined)` legal. A page holding only one of the two names cannot
 * notice that stopping being true.
 */
export function startWith(
  submit: (input: SubmitInputOf<DigestWorkflow>) => Promise<void>,
  url: string,
): Promise<void> {
  const input: DigestInput = { url };
  return submit(input);
}

/** What the page prints once a run completes — a reader of the def's OUTPUT type. */
export function headline(output: DigestOutput): string {
  return `${output.headline} (${output.points.length} points)`;
}

/** What the history list contributes, read through its published result type. */
export function previous(runs: UseWorkflowRunsResult<Digest>): readonly WorkflowRun<Digest>[] {
  return runs.runs.filter((one) => isTerminal(one));
}

/**
 * The upload bar's own caption.
 *
 * `UploadStatus` is the SDK's per-request progress plus WHICH file it describes,
 * and this reads both halves: without `index`/`count` a form sending more than
 * one file renders a bar that restarts at zero with nothing to say why, and
 * `paused` is what separates "parked" from "stalled" — a distinction a page can
 * otherwise only guess at from a number that stopped moving.
 */
export function uploadCaption(upload: UploadStatus): string {
  const pct = upload.fraction === undefined ? "…" : `${Math.round(upload.fraction * 100)}%`;
  const state = upload.paused ? "paused" : `${upload.loaded} of ${upload.total ?? "?"} bytes`;
  return `${upload.name} (${upload.index}/${upload.count}) — ${pct}, ${state}`;
}

/**
 * A picker over the agent's own declared workflows.
 *
 * The listing is what a declared form is rendered FROM — each summary carries
 * the JSON Schema of that workflow's input — so a page reading it by hand is
 * the shape that pins `WorkflowSummary` into this capability. `skip` is named
 * because it is the field that lets a caller who may not need the listing avoid
 * a conditional hook.
 */
function Picker({ onPick }: { onPick: (summary: WorkflowSummary) => void }) {
  const options: UseWorkflowsOptions = { api, skip: false };
  const listing: UseWorkflowsResult = useWorkflows(options);
  if (listing.loading) return <p>Loading…</p>;
  if (listing.error !== undefined) return <p role="alert">{listing.error}</p>;
  return (
    <ul>
      {listing.workflows.map((summary: WorkflowSummary) => (
        <li key={summary.name}>
          <button onClick={() => onPick(summary)} type="button">
            {summary.description ?? summary.name}
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * The run's narration, read through the HOOK rather than the component.
 *
 * `<WorkflowProgress>` renders this for a page that wants the default list;
 * the hook is for one that does not, and it is the only half that exposes
 * `supported` — which is what tells "this deploy predates progress streams"
 * apart from "the run has written nothing yet". Both look identical from the
 * lines alone, and a page reading only the lines hides nothing and shows an
 * empty section forever.
 */
function Narration({ runId }: { runId: string | undefined }) {
  const progress: UseWorkflowProgressResult = useWorkflowProgress(runId, { api });
  if (!progress.supported) return null;
  return (
    <section>
      {/*
       * The COUNT and the newest line rather than the list. A run's narration
       * is append-only and its lines are not unique, so rendering it needs a
       * key strategy — and this file's job is to freeze
       * `UseWorkflowProgressResult`'s shape, which reading three fields off it
       * does just as well. `<WorkflowProgress>` above is the component that
       * really renders the log.
       */}
      <p>{progress.progress.length} line(s)</p>
      <p>{progress.streaming ? (progress.latest ?? "…") : "done"}</p>
    </section>
  );
}

/**
 * The audio a completed run stored, played back in the browser.
 *
 * The id is passed straight through while it does not exist yet, which is what
 * `pending` is a separate field for: "neither url nor error" cannot tell a
 * download in flight from nothing to download, and those are the two states a
 * page most wants to render differently.
 */
function Playback({ uploadId }: { uploadId: string | undefined }) {
  const options: UseDownloadUrlOptions = { api };
  const audio: UseDownloadUrlResult = useDownloadUrl(uploadId, options);
  if (audio.pending) return <p>Fetching audio…</p>;
  if (audio.error !== undefined) return <p role="alert">{audio.error}</p>;
  return audio.url === undefined ? null : (
    <a href={audio.url} download="digest.mp3">
      Download
    </a>
  );
}

/** The page, epoch 7. */
export function Page() {
  // An explicit key, which is what epoch 7 offered before the hook defaulted one.
  const key = useRunKey();
  const options: UseWorkflowSubmitOptions = { api, key, intervalMs: 1000 };
  const { submit, run, pending, error, upload, reset, wake, cancel } =
    useWorkflowSubmit<DigestWorkflow>("digest", options);
  const historyOptions: UseWorkflowRunsOptions = { api, limit: 5, key };
  const history = useWorkflowRuns<Digest>("digest", historyOptions);
  // A second watch on the same id, which is how a panel followed a run it was
  // handed rather than one it started.
  const followed: UseWorkflowRunResult<Digest> = useWorkflowRun<Digest>(run?.runId, { api });
  const done = followed.run?.status === "completed" ? followed.run.output : undefined;

  return (
    <main>
      <Picker onPick={(summary) => console.log(summary.name)} />
      <button onClick={() => void startWith(submit, "https://example.test")} type="button">
        Digest
      </button>
      {upload && (
        <>
          <UploadProgressBar upload={upload} />
          <p>{uploadCaption(upload)}</p>
        </>
      )}
      {error !== undefined && <p>{error}</p>}
      {run && (
        <section>
          <h2>{STATUS_LINE[run.status]}</h2>
          <WorkflowProgress runId={run.runId} api={api} />
          <Narration runId={run.runId} />
          {done && <h3>{headline(done)}</h3>}
          <Playback uploadId={done?.audio} />
          {followed.polling && <p>watching…</p>}
          <button onClick={reset} type="button">
            Clear
          </button>
          <button onClick={() => void wake()} type="button">
            Send it now
          </button>
          <button onClick={() => void cancel()} type="button">
            Stop
          </button>
        </section>
      )}
      <ul>
        {previous(history).map((one) => (
          <li key={one.runId}>{STATUS_LINE[one.status]}</li>
        ))}
      </ul>
      <p>{pending ? "working" : "idle"}</p>
    </main>
  );
}

/**
 * The same page against the STREAMING sibling.
 *
 * A drop-in for `useWorkflowSubmit` — same `<Form>`, same `<UploadProgressBar>`
 * — differing only in WHEN the run exists: here it is created before its bytes
 * are, so `run` is set while the upload is still going and the page can narrate
 * beside the bar rather than after it. The options type says the same thing from
 * the other side, being `UseWorkflowSubmitOptions` minus the two fields that
 * cannot mean anything for a run that starts first.
 */
export function StreamedPage() {
  const options: UseWorkflowStreamOptions = { api, intervalMs: 1000 };
  const submission: WorkflowStreamSubmission<
    Digest,
    SubmitInputOf<DigestWorkflow>
  > = useWorkflowStream<DigestWorkflow>("digest", options);
  const { run, upload, pauseUpload, resumeUpload } = submission;

  return (
    <main>
      <button
        onClick={() => void startWith(submission.submit, "https://example.test")}
        type="button"
      >
        Stream it
      </button>
      {upload && (
        <>
          <UploadProgressBar upload={upload} />
          <p>{uploadCaption(upload)}</p>
          <button onClick={upload.paused ? resumeUpload : pauseUpload} type="button">
            {upload.paused ? "Resume" : "Pause"}
          </button>
        </>
      )}
      {run && <Narration runId={run.runId} />}
      <p>{summarize(submission)}</p>
    </main>
  );
}
