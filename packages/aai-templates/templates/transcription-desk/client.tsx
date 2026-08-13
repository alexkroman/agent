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
 * `GET /workflows` — so the file picker and the language picker exist because
 * `agent.ts` declares `recording` and `languageCode`, `.describe()` is what
 * labels them, the enum is what makes the second a `<SelectField>`, and adding a
 * third scalar there adds a third control here with no edit.
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
  page,
  SubmitButton,
  TextField,
  useWorkflowProgress,
  useWorkflowRun,
  useWorkflowSubmit,
  WorkflowFields,
  type WorkflowRun,
} from "@alexkroman1/aai-ui";
import { useState } from "react";
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

function TranscriptionDesk() {
  const { submit, run, pending, error, reset } = useWorkflowSubmit<Transcript>(WORKFLOW);

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

      <RunLookup />
    </main>
  );
}

/**
 * Look a run up by the id the API returned.
 *
 * The reason this is possible at all: a run id is the whole handle. There is no
 * session behind it, no cookie, and no correlation key — the API hands one back
 * and `GET /workflows/runs/:id` answers for it from any tab, any machine, days
 * later. That is what a durable workflow with an HTTP API buys, and it is worth
 * one text field to show.
 */
function RunLookup() {
  const [runId, setRunId] = useState<string | undefined>(undefined);
  const { run, error } = useWorkflowRun<Transcript>(runId);

  return (
    <section className="flex flex-col gap-4 border-t pt-6">
      <h2 className="text-sm font-medium uppercase tracking-[1.2px]">Check a previous run</h2>
      <Form onSubmit={(values) => setRunId(String(values.runId))} error={error}>
        <TextField name="runId" label="Run id" required placeholder="wrun_…" />
        <SubmitButton>Look up</SubmitButton>
      </Form>
      {run && <RunPanel run={run} />}
    </section>
  );
}

/**
 * The run's own narration, oldest first.
 *
 * The complement of `STATUS_LINE` below, and the reason both exist: the status is
 * `running` for the whole fan-out, so a sixty-segment recording and a
 * one-segment recording look identical while they run. These lines come from the
 * run itself (`report()` in `workflows/transcribe.ts`), which is the only channel
 * a workflow has before it produces an output.
 *
 * They also REPLAY — chunks are retained with the run — so looking a finished run
 * up in the panel below shows how it got there, not an empty box.
 */
function ProgressLog({ runId }: { runId: string }) {
  const { progress, streaming, supported } = useWorkflowProgress(runId);

  // `supported` is what keeps this from being an empty box forever on an agent
  // deployed before progress streams existed: "wrote nothing yet" and "serves no
  // stream" are indistinguishable from the list alone.
  if (!supported || progress.length === 0) return null;

  // Rendered as TEXT rather than a list of elements, and that is not only a
  // styling choice: these lines are append-only and segments legitimately produce
  // identical text, so there is no stable per-line key to give React. Joining
  // sidesteps the question instead of suppressing the lint rule that asks it.
  return (
    <pre className="whitespace-pre-wrap border-l pl-4 text-xs opacity-70">
      {progress.join("\n")}
      {streaming && "\n…"}
    </pre>
  );
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

      <ProgressLog runId={run.runId} />

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
