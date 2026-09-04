// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-ui:workflow` epoch 8.
 *
 * The browser half of a clinic's intake app — the `client.tsx` a workflow app
 * ships: a form that starts a run and follows it, a recording upload that sends
 * its parts in parallel and can be paused, the run's own narration, and a
 * history pane that finds the runs this browser started even after a reload.
 * Written the way it was authored at epoch 8, and it must keep compiling for as
 * long as that epoch is advertised as supported.
 *
 * ## What moved, and why epoch 8 survives it
 *
 * Nothing this capability exports, and — unlike the five SDK capabilities
 * retained in the same change — nothing to do with a workflow BODY either. This
 * report does not reach `WorkflowBody` at all: everything here is the client
 * side of the wire, so the def only ever appears as a type PARAMETER.
 *
 * What moved is one type this surface names structurally.
 * `UseWorkflowSubmitOptions.parallel` used to be typed `UploadParallel`, from
 * `@alexkroman1/aai/workflow-api`, and that type is now
 * `UploadParallelOption` — a rename for what it is, an OPTION rather than a
 * thing, and it belongs to the SDK's own upload surface rather than to this one.
 * Because `UseWorkflowStreamOptions` is
 * `Omit<UseWorkflowSubmitOptions, "wait" | "recover">`, the field arrives on
 * both submit hooks, and both are used below.
 *
 * **The example survives because a caller passes a VALUE, not a type.**
 * `UploadParallelOption` is `boolean | UploadPartsOptions`, so
 * {@link IntakePane} writes `parallel: true` and {@link RecordingPane} writes
 * `parallel: { partBytes: …, concurrency: … }` — an object literal checked
 * against a type neither of them names. Renaming a type nothing spells cannot
 * break anything, which is what makes this a retain rather than a drop.
 *
 * **The directions that WOULD break this file** are the ones this capability's
 * shape turns on. The def type parameter going back to meaning the OUTPUT type,
 * which would make `useWorkflowSubmit<Intake>` mean something else entirely.
 * {@link WorkflowSubmission} losing `wake`, which is the counterpart of the
 * `ctx.sleep` in the app's own body and is the difference between "file it now"
 * and "throw it away". `run` ceasing to be the DISCRIMINATED union, which is
 * what lets the `status === "completed"` branch read a typed `output`. Or
 * `useWorkflowRuns` losing `key`, which is the only way a reload finds the runs
 * this browser started.
 *
 * Editing this file to make a future error go away defeats the mechanism: the
 * error IS the finding, and it means epoch 8 has to be dropped with a reason.
 */

import type { ToolInputSchema } from "@alexkroman1/aai";
import type { WorkflowDef } from "@alexkroman1/aai/workflow-api";
import { useCallback, useState } from "react";
import {
  createWorkflowApi,
  isTerminal,
  type SubmitInputOf,
  UploadProgressBar,
  type UploadStatus,
  type UseDownloadUrlOptions,
  type UseDownloadUrlResult,
  type UseWorkflowProgressResult,
  type UseWorkflowRunResult,
  type UseWorkflowRunsOptions,
  type UseWorkflowRunsResult,
  type UseWorkflowStreamOptions,
  type UseWorkflowSubmitOptions,
  type UseWorkflowsOptions,
  type UseWorkflowsResult,
  useDownloadUrl,
  useRunKey,
  useWorkflowProgress,
  useWorkflowRun,
  useWorkflowRuns,
  useWorkflowStream,
  useWorkflowSubmit,
  useWorkflows,
  WORKFLOW_STATUS_LABELS,
  type WorkflowApi,
  type WorkflowApiOptions,
  type WorkflowInputOf,
  type WorkflowOutputOf,
  WorkflowProgress,
  type WorkflowRun,
  type WorkflowRunStatus,
  type WorkflowStreamSubmission,
  type WorkflowSubmission,
  type WorkflowSummary,
} from "../../../index.ts";

/**
 * ── EDIT: what the app's workflow answers with. ──────────────────────────
 *
 * A real `client.tsx` writes `import type { intake } from "./agent.ts"` — the
 * type-only import is ERASED, so naming the agent's own def costs the bundle
 * nothing and stops the page restating a shape the workflow already declares. A
 * frozen example has no `agent.ts` beside it, so the def's TYPE is written out
 * here, with the input left as the open {@link ToolInputSchema} a page gets for
 * a workflow whose declared schema it cannot see.
 */
export interface IntakeRecord {
  patient: string;
  filedAt: number;
  reviewed: boolean;
  /** The filed form, as an upload id the page can offer for download. */
  formUploadId?: string;
}

type Intake = WorkflowDef<ToolInputSchema, IntakeRecord>;

/**
 * The three types a page reads OFF the def rather than restating.
 *
 * {@link WorkflowOutputOf} types a completed run's `output`, {@link
 * WorkflowInputOf} is what the schema parses to, and {@link SubmitInputOf} is
 * the one `submit` takes — the same thing, except that a workflow declaring no
 * input is `undefined` there rather than an unusable `never`. Deriving them is
 * what keeps a second copy of the workflow's shape off this page.
 */
export type IntakeOutput = WorkflowOutputOf<Intake>;
export type IntakeInput = WorkflowInputOf<Intake>;
export type IntakeSubmit = SubmitInputOf<Intake>;

/** ── EDIT: where the agent lives. ──────────────────────────────────────── */
const apiOptions: WorkflowApiOptions = { baseUrl: "/.well-known/workflow/v1" };

/**
 * One client for the whole page, built at module scope and passed to every
 * hook: they all talk to the same agent, and a client per hook is a client per
 * render for anything that memoizes badly.
 */
const api: WorkflowApi = createWorkflowApi(apiOptions);

/** The status, in the words the framework already has for it. A page that wrote
 *  its own map would disagree with the rest of the product on one of them. */
function statusLabel(status: WorkflowRunStatus): string {
  return WORKFLOW_STATUS_LABELS[status];
}

/**
 * ── EDIT: the form pane. ─────────────────────────────────────────────────
 *
 * `useWorkflowSubmit` starts the run, follows its STATUS, and hands back the
 * controls bound to whatever run it is following — so the page holds no run id
 * of its own and no client of its own.
 *
 * The options are annotated so the bag is readable on its own. `key` is the
 * handle that survives a reload — the run outlives the tab either way, and
 * without a key nothing can find it again — and `wait` asks the agent to hold
 * the response open briefly, so a run that finishes at once is complete by the
 * time `submit` resolves. **`parallel: true` is the field whose TYPE moved**:
 * `true` means "the defaults", and it is a value rather than a name, which is
 * the whole reason this epoch is retained rather than dropped.
 */
function IntakePane({ runKey }: { runKey: string }): React.ReactNode {
  const [patient, setPatient] = useState("");
  const [reason, setReason] = useState("");

  const options: UseWorkflowSubmitOptions = {
    api,
    key: runKey,
    wait: 2000,
    intervalMs: 1500,
    parallel: true,
  };
  const {
    submitForm,
    run,
    pending,
    error,
    wake,
    cancel,
    reset,
  }: WorkflowSubmission<IntakeOutput, Record<string, unknown>> = useWorkflowSubmit<Intake>(
    "intake",
    options,
  );

  const onSubmit = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      // `submitForm` takes the form's own values, which is what a hand-written
      // form has; `submit` is the same call for a page holding a typed input.
      const values: IntakeInput = { patient, reason };
      void submitForm(values);
    },
    [patient, reason, submitForm],
  );

  return (
    <section className="flex flex-col gap-4">
      <form onSubmit={onSubmit} className="flex flex-col gap-2">
        <input
          required
          value={patient}
          onChange={(event) => setPatient(event.target.value)}
          placeholder="Patient name"
          className="rounded-md border px-3 py-2"
        />
        <textarea
          required
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="What are they coming in for?"
          className="rounded-md border px-3 py-2"
        />
        <button type="submit" disabled={pending} className="rounded-md border px-4 py-2">
          {pending ? "Filing…" : "File intake"}
        </button>
      </form>

      {/* The agent's own sentence for a rejected input, which is better copy
          than anything this page could write. */}
      {error !== undefined && <p className="text-red-600">{error}</p>}

      {/* What the run wrote about itself, newest line only. Progress REPLAYS,
          so a reload catches up rather than starting from whatever arrives
          next — which only pays off because the reload can name its run again. */}
      <WorkflowProgress runId={run?.runId} lines={1} api={api} className="text-sm opacity-70" />

      {pending && (
        <div className="flex gap-2">
          {/* The counterpart of the review window the body sleeps through.
              Without it the only handle on a sleeping run is `cancel`, so
              "file it now" and "throw it away" would be one button. `wake`
              answering 0 means the run had already moved on, which is not a
              failure. */}
          <button type="button" onClick={() => void wake()} className="rounded border px-3 py-1">
            Skip the review window
          </button>
          <button type="button" onClick={() => void cancel()} className="rounded border px-3 py-1">
            Cancel
          </button>
        </div>
      )}

      {run?.status === "failed" && <p className="text-red-600">That one failed: {run.error}</p>}

      {run?.status === "completed" && (
        <article className="flex flex-col gap-1">
          {/* Typed, because the def type parameter is the DEF and the output is
              derived from it. */}
          <h3 className="text-lg">{run.output.patient} is filed</h3>
          <p className="text-sm opacity-70">{statusLabel(run.status)}</p>
          <FiledForm uploadId={run.output.formUploadId} />
          <button type="button" onClick={reset} className="self-start rounded border px-3 py-1">
            File another
          </button>
        </article>
      )}
    </section>
  );
}

/**
 * The filed form, as something the reader can open.
 *
 * `useDownloadUrl` mints a URL for an upload the run produced, and an absent id
 * is not an error — the run may not have filed anything — so the hook takes
 * `undefined` and stays quiet.
 */
function FiledForm({ uploadId }: { uploadId: string | undefined }): React.ReactNode {
  const downloadOptions: UseDownloadUrlOptions = { api };
  const { url, error, pending }: UseDownloadUrlResult = useDownloadUrl(uploadId, downloadOptions);
  if (uploadId === undefined) return null;
  if (pending) return <p className="text-sm opacity-70">Preparing the form…</p>;
  if (error !== undefined) return <p className="text-sm text-red-600">{error}</p>;
  return (
    <a href={url} className="text-sm underline">
      Open the filed form
    </a>
  );
}

/**
 * ── EDIT: the recording pane. ────────────────────────────────────────────
 *
 * `useWorkflowStream` is the other submit hook: the run starts while the upload
 * is still arriving, which is what makes a long recording worth streaming
 * rather than waiting out. Its options are `UseWorkflowSubmitOptions` minus
 * `wait` and `recover` — neither means anything for a run that begins before
 * its input is complete — so `parallel` arrives here too, tuned rather than
 * defaulted.
 */
function RecordingPane({ runKey }: { runKey: string }): React.ReactNode {
  const options: UseWorkflowStreamOptions = {
    api,
    key: runKey,
    // The OBJECT form of the same option: a consultation recording is large and
    // the link is the bottleneck, so the parts are bigger and there are more of
    // them in flight. Still a value — the type it satisfies is named nowhere.
    parallel: { partBytes: 16 * 1024 * 1024, concurrency: 8 },
  };
  const {
    submit,
    upload,
    pauseUpload,
    resumeUpload,
    run,
    error,
  }: WorkflowStreamSubmission<IntakeOutput, IntakeSubmit> = useWorkflowStream<Intake>(
    "transcribeVisit",
    options,
  );

  const onPick = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (file) void submit({ recording: file });
    },
    [submit],
  );

  return (
    <section className="flex flex-col gap-3">
      <input type="file" accept="audio/*" onChange={onPick} className="text-sm" />
      <UploadBar upload={upload} onPause={pauseUpload} onResume={resumeUpload} />
      {error !== undefined && <p className="text-red-600">{error}</p>}
      {run !== undefined && <p className="text-sm opacity-70">{statusLabel(run.status)}</p>}
    </section>
  );
}

/** What the pane hands the bar, written down so a reader can see it is the
 *  hook's own value: bytes, which file, and whether a person paused it. */
export type PickedUpload = UploadStatus | undefined;

/**
 * The upload's own progress, paired with its controls. Naming
 * {@link UploadStatus} in the props is what lets the pane pass the hook's value
 * straight through without restating its shape.
 */
function UploadBar(props: {
  upload: PickedUpload;
  onPause: () => void;
  onResume: () => void;
}): React.ReactNode {
  return <UploadProgressBar {...props} className="w-full" />;
}

/**
 * ── EDIT: the history pane. `useWorkflowRuns` with the same `key` is how the
 * page answers "what did this browser file", including runs it did not start on
 * this load. `refresh` is for the button, since nothing pushes here.
 */
function HistoryPane({ runKey }: { runKey: string }): React.ReactNode {
  const options: UseWorkflowRunsOptions = { api, key: runKey, limit: 10 };
  const { runs, loading, error, refresh }: UseWorkflowRunsResult<IntakeOutput> =
    useWorkflowRuns<IntakeOutput>("intake", options);

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h2 className="text-lg">Filed today</h2>
        <button type="button" onClick={refresh} className="rounded border px-2 py-1 text-sm">
          Refresh
        </button>
      </div>
      {loading && <p className="text-sm opacity-70">Looking…</p>}
      {error !== undefined && <p className="text-red-600">{error}</p>}
      <ul className="flex flex-col gap-2">
        {runs.map((entry) => (
          <HistoryRow key={entry.runId} run={entry} />
        ))}
      </ul>
    </section>
  );
}

/**
 * One row. `isTerminal` is the guard rather than a comparison against a status
 * list this page maintains: a settled run gets its result, an unsettled one its
 * newest progress line, and only the framework knows which is which.
 */
function HistoryRow({ run }: { run: WorkflowRun<IntakeOutput> }): React.ReactNode {
  return (
    <li className="flex flex-col gap-1 rounded-md border p-2">
      <span className="text-sm">{statusLabel(run.status)}</span>
      {run.status === "completed" ? (
        <span>{run.output.patient}</span>
      ) : (
        !isTerminal(run) && <RunTail runId={run.runId} />
      )}
    </li>
  );
}

/**
 * The newest line a run has written, as the HOOK rather than the component:
 * this needs one string inside a row it does not control, so it reads `latest`
 * and renders nothing for an agent that serves no stream — which `supported` is
 * how it tells apart from a run that has said nothing yet.
 */
function RunTail({ runId }: { runId: string }): React.ReactNode {
  const { latest, supported }: UseWorkflowProgressResult = useWorkflowProgress(runId, {
    api,
    intervalMs: 2000,
  });
  if (!supported) return null;
  return <span className="text-sm opacity-70">{latest ?? "…"}</span>;
}

/**
 * ── EDIT: a run somebody was SENT. ───────────────────────────────────────
 *
 * `useWorkflowRun` watches ONE run by id, which is the case a shared link is —
 * a nurse opening the URL a receptionist pasted into chat. No form, no upload,
 * no key, just the id.
 *
 * `polling` cannot be derived from the snapshot: an id the agent never knew
 * leaves `run` undefined, which would otherwise read as "still waiting" for the
 * life of the tab. The hook gives up after a bounded number of missing reads.
 */
function SharedRun({ runId }: { runId: string | undefined }): React.ReactNode {
  const { run, error, polling }: UseWorkflowRunResult<IntakeOutput> = useWorkflowRun<IntakeOutput>(
    runId,
    { api, intervalMs: 2000 },
  );
  if (runId === undefined) return null;
  if (error !== undefined) return <p className="text-red-600">{error}</p>;
  if (run === undefined) {
    return (
      <p className="text-sm opacity-70">{polling ? "Looking for that run…" : "No such run."}</p>
    );
  }
  return (
    <p className="text-sm">
      {statusLabel(run.status)}
      {run.status === "completed" ? ` — ${run.output.patient}` : ""}
    </p>
  );
}

/**
 * ── EDIT: the page. ──────────────────────────────────────────────────────
 *
 * The listing is what makes the header honest: the description comes from the
 * agent's own `workflow({ description })` rather than being copied here, so the
 * two cannot disagree. `useRunKey({ storage: "local" })` because a clinic's runs
 * should be findable tomorrow rather than only for this tab — and the key may
 * not be derived from the data being filed or carried in the URL; it is this
 * browser's private handle on its own runs.
 */
export function App(): React.ReactNode {
  const runKey = useRunKey({ storage: "local" });
  const listing: UseWorkflowsOptions = { api };
  const { workflows }: UseWorkflowsResult = useWorkflows(listing);
  const intake: WorkflowSummary | undefined = workflows.find((entry) => entry.name === "intake");

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-8 p-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-medium">Clinic Intake</h1>
        {intake?.description !== undefined && (
          <p className="text-sm opacity-70">{intake.description}</p>
        )}
      </header>
      <SharedRun runId={new URLSearchParams(window.location.search).get("run") ?? undefined} />
      <IntakePane runKey={runKey} />
      <RecordingPane runKey={runKey} />
      <HistoryPane runKey={runKey} />
    </main>
  );
}
