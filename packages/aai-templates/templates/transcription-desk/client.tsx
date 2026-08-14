// Copyright 2026 the AAI authors. MIT license.
/**
 * The transcription desk's page: a form, a progress log, and a transcript.
 *
 * `link-digest` is the smaller example and the one to read first — it shows the
 * primitives raw: `createWorkflowApi()` to start a run, `useWorkflowRun()` to
 * watch it, and a hand-written `<form>` with its own `useState`. This page is
 * the same thing with the two pieces that hand-rolling gets tedious:
 *
 * - **`useWorkflowSubmit`** is `api.start` plus `useWorkflowRun` plus the four
 *   pieces of state between them (the run id, the in-flight submit, whether the
 *   RUN is still going, and which of the two failed).
 * - **`<Form>` and the field components** collect the values off the DOM, typed
 *   — a number field yields a number, a checkbox a boolean, an empty optional
 *   field nothing at all — which matters because those values go straight into
 *   the workflow's input where a zod schema is waiting.
 *
 * ## The form is DECLARED, not written
 *
 * There is no field markup here at all. `<WorkflowFields>` renders a control per
 * SCALAR property of the workflow's own input schema, which it reads from
 * `GET /workflows` — so the file picker exists because `agent.ts` declares
 * `recording`, `.describe()` is what labels it, and adding a second scalar there
 * adds a second control here with no edit. (A language picker used to sit beside
 * it, and went with the schema field: the model detects the language, so the
 * control asked a person to answer a question the service answers better.)
 *
 * The FILE half is the same mechanism one step further: `recording` is a string
 * in the schema (it carries an upload id) and appears in the workflow's
 * `uploads` list, which is what turns it into a file picker — and
 * `useWorkflowSubmit` stores the chosen file through `POST /workflows/uploads`
 * before it starts the run. A run input is journaled and replayed, so bytes can
 * never travel in one; this page contains no upload code because the SDK owns
 * that.
 *
 * That works because this workflow's input is scalars all the way down. A page
 * whose schema has an object or array property writes those fields itself, in
 * the same `<Form>` — every field in `@alexkroman1/aai-ui` is a plain named
 * control, so declared and hand-written ones mix freely.
 */

import "@alexkroman1/aai-ui/styles.css";
import type { WorkflowOutputOf } from "@alexkroman1/aai";
import {
  Form,
  isTerminal,
  page,
  SubmitButton,
  useWorkflowRuns,
  useWorkflowSubmit,
  WorkflowFields,
  WorkflowProgress,
  type WorkflowRun,
} from "@alexkroman1/aai-ui";
import { useEffect, useState } from "react";
import type { transcribe } from "./agent.ts";

/**
 * What a finished run reports.
 *
 * Derived from the workflow declaration rather than restated — `import type` is
 * erased, so naming `transcribe` here bundles none of the agent, the SDK, or the
 * workflow body into this page.
 */
type Transcript = WorkflowOutputOf<typeof transcribe>;

/** The workflow this page drives. Matches the key in `workflowApp({ workflows })`. */
const WORKFLOW = "transcribe";

/** Most past runs the history list shows. */
const HISTORY_LIMIT = 10;

function TranscriptionDesk() {
  const { submit, run, pending, error, reset } = useWorkflowSubmit<Transcript>(WORKFLOW);
  const history = useWorkflowRuns<Transcript>(WORKFLOW, { limit: HISTORY_LIMIT });
  // Which past run the reader is looking at, if any. Its own state rather than
  // a route, because a workflow app is one page and a run id is not a place.
  const [openId, setOpenId] = useState<string | undefined>(undefined);

  // The list is read once and re-read on demand (see `useWorkflowRuns`), and
  // this is the "on demand": the moment the run this page started settles, the
  // history it is missing from is stale. `run.status` rather than `run` — the
  // watch re-reads on an interval, and depending on the object would refetch
  // the whole list every poll.
  const settled = run && isTerminal(run) ? run.runId : undefined;
  const refresh = history.refresh;
  useEffect(() => {
    if (settled) refresh();
  }, [settled, refresh]);

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-8 p-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-medium">Transcription Desk</h1>
        <p className="text-sm opacity-70">
          Upload a WAV recording. It is split into chunks, transcribed chunk by chunk, and stitched
          back together by a durable workflow — so you can close this tab and come back to it.
        </p>
      </header>

      {/* No mapping: the collected values already match the input schema. */}
      <Form onSubmit={(values) => submit(values)} error={error}>
        {/* The NAME, so the schema is fetched here rather than by this page. */}
        <WorkflowFields workflow={WORKFLOW} />
        <SubmitButton pending={pending}>Transcribe</SubmitButton>
      </Form>

      {run && <RunPanel run={run} onClear={reset} />}

      <History
        runs={history.runs}
        error={history.error}
        openId={openId}
        onOpen={(runId) => setOpenId((current) => (current === runId ? undefined : runId))}
      />
    </main>
  );
}

/**
 * Every recent run, newest first, with its transcript one click away.
 *
 * This is what a durable workflow with an HTTP API is FOR, and the page used to
 * squander it: a run id is the whole handle — no session, no cookie — so
 * `GET /workflows/runs` can answer "what has this desk transcribed" for any tab,
 * any machine, days later. What stood here instead was a text box asking the
 * reader to paste an id they would have had to write down, which is the same
 * information behind a worse door.
 */
function History({
  runs,
  error,
  openId,
  onOpen,
}: {
  runs: WorkflowRun<Transcript>[];
  error: string | undefined;
  openId: string | undefined;
  onOpen: (runId: string) => void;
}) {
  return (
    <section className="flex flex-col gap-3 border-t pt-6">
      <h2 className="text-sm font-medium uppercase tracking-[1.2px]">Previous runs</h2>
      {error !== undefined && <p className="text-sm text-red-600">{error}</p>}
      {runs.length === 0 && error === undefined && (
        <p className="text-sm opacity-60">Nothing transcribed yet.</p>
      )}
      <ul className="flex flex-col">
        {runs.map((entry) => (
          <li key={entry.runId} className="border-b last:border-b-0">
            <button
              type="button"
              onClick={() => onOpen(entry.runId)}
              className="flex w-full items-baseline justify-between gap-4 py-2 text-left text-sm"
            >
              <span className="truncate">{title(entry)}</span>
              <span className="shrink-0 text-xs opacity-60">{STATUS_LINE[entry.status]}</span>
            </button>
            {openId === entry.runId && <RunPanel run={entry} />}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * One line naming a past run.
 *
 * The FILE where there is one — `mergeTranscript` puts the recording's own name
 * in the output for exactly this — falling back to the id, which is all a run
 * that failed before it read the upload ever had.
 */
function title(run: WorkflowRun<Transcript>): string {
  if (run.status === "completed") return run.output.source;
  return run.runId;
}

/** The run's status, its narration, and its transcript once there is one. */
function RunPanel({ run, onClear }: { run: WorkflowRun<Transcript>; onClear?: () => void }) {
  return (
    <section className="flex flex-col gap-3 rounded-md border p-5">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-sm font-medium uppercase tracking-[1.2px]">
          {STATUS_LINE[run.status]}
        </h2>
        {onClear && (
          <button type="button" onClick={onClear} className="text-xs underline opacity-60">
            Clear
          </button>
        )}
      </div>

      {/* The run's own narration, oldest first — the complement of `STATUS_LINE`
          below, and the reason both exist: the status is `running` for the whole
          fan-out, so a sixty-segment recording and a one-segment recording look
          identical while they run. These lines come from the run itself
          (`report()` in `workflows/transcribe.ts`), and they REPLAY, so looking a
          finished run up in the panel below shows how it got there. */}
      <WorkflowProgress runId={run.runId} />

      {/* Discriminated on `status`, so `output` and `error` are reachable
          without a cast — the reason a snapshot is a union rather than a flat
          object with optional fields. */}
      {run.status === "completed" && (
        <>
          <p className="text-xs opacity-60">
            {run.output.segments} segments · {Math.round(run.output.durationMs / 1000)}s ·{" "}
            {run.output.words} words
          </p>
          <pre className="whitespace-pre-wrap text-sm leading-relaxed">{run.output.transcript}</pre>
        </>
      )}
      {run.status === "failed" && <p className="text-red-600">{run.error}</p>}
    </section>
  );
}

/**
 * One line describing where a run has got to.
 *
 * A `Record` keyed by the status union rather than a switch, so a status added
 * to the SDK is a compile error here instead of falling through a `default:`
 * into whichever line was last.
 */
const STATUS_LINE: Record<WorkflowRun["status"], string> = {
  pending: "Queued",
  running: "Transcribing…",
  completed: "Transcript ready",
  failed: "Failed",
  cancelled: "Cancelled",
};

page({ name: "Transcription Desk", component: TranscriptionDesk });
