// Copyright 2026 the AAI authors. MIT license.
/**
 * The transcription desk's page: an upload form, a status line, and a
 * transcript.
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
 * ## The form is half declared and half written
 *
 * `<WorkflowFields>` renders a control per SCALAR property of the workflow's own
 * input schema, read from `GET /workflows` — so `requestedBy` and `redact` exist
 * here because `agent.ts` declares them, and adding a third scalar there would
 * add a third control here with no edit. `upload` is an object, which has no
 * honest default control, so its `<FileField>` is written by hand. Both live in
 * one `<Form>` because every field is a plain named control.
 *
 * That is also why the submit handler does no mapping: a `<FileField>`
 * contributes `{ name, type, size, … }` under its own name, which is exactly the
 * shape `upload` declares.
 */

import "@alexkroman1/aai-ui/styles.css";
import type { WorkflowOutputOf } from "@alexkroman1/aai";
import {
  FileField,
  Form,
  page,
  SubmitButton,
  TextField,
  useWorkflowRun,
  useWorkflowSubmit,
  useWorkflows,
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

/** The workflow this page drives. Matches the key in `agent({ workflows })`. */
const WORKFLOW = "transcribe";

function TranscriptionDesk() {
  // The declared workflows, for the schema `<WorkflowFields>` renders from.
  const { workflows, error: listError } = useWorkflows();
  const { submit, run, pending, error, reset } = useWorkflowSubmit<Transcript>(WORKFLOW);

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-8 p-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-medium">Transcription Desk</h1>
        <p className="text-sm opacity-70">
          Upload a recording. The transcript is produced by a durable workflow, so you can close
          this tab and come back to it.
        </p>
      </header>

      {/* No mapping: the collected values already match the input schema. */}
      <Form onSubmit={(values) => submit(values)} error={error ?? listError}>
        <FileField
          name="upload"
          label="Recording"
          accept="audio/*,video/*"
          required
          hint="Only the file's name, type and size are sent — see the module comment."
        />
        <WorkflowFields workflow={workflows.find((summary) => summary.name === WORKFLOW)} />
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

/** The run's status, and its transcript once there is one. */
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

      {/* Discriminated on `status`, so `output` and `error` are reachable
          without a cast — the reason a snapshot is a union rather than a flat
          object with optional fields. */}
      {run.status === "completed" && (
        <>
          <p className="text-xs opacity-60">
            {run.output.segments} segments · {run.output.words} words · filed{" "}
            {new Date(run.output.filedAt).toLocaleString()}
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
