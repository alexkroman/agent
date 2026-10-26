// Copyright 2026 the AAI authors. MIT license.
/**
 * The transcription desk's page: a form, a progress log, and a transcript.
 *
 * `link-digest-workflow` is the smaller example and the one to read first — it shows the
 * layer under `<Form>` raw: a hand-written `<form>` with its own `useState`,
 * handing an object to `submit()`. This page is the same thing with the two
 * pieces that hand-rolling gets tedious:
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
 * property of the workflow's own input schema, which it reads from
 * `GET /workflows` — so the file picker exists because `agent.ts` declares
 * `recording` in `uploads`, `.describe()` is what labels it, and adding a second
 * property there adds a second control here with no edit.
 *
 * The FILE half is the same mechanism one step further: `recording` is a string
 * in the schema (it carries an upload id) and appears in the workflow's
 * `uploads` list, which is what turns it into a file picker — and
 * `useWorkflowSubmit` stores the chosen file through `POST /workflows/uploads`
 * before it starts the run. A run input is journaled and replayed, so bytes can
 * never travel in one; this page contains no upload code because the SDK owns
 * that.
 *
 * ## Three modes, and the toggle is the template's subject
 *
 * The desk offers all three flows the agent declares, and the page is where the
 * difference is legible: pick "while it uploads" and there is a run to watch
 * before any bytes are in, pick "after it uploads" and there is not. They share
 * everything else — one `<Form>`, one picker, one progress log, one transcript —
 * because they take the same input and return the same shape, and the only thing
 * the page chooses is which HOOK submits it.
 *
 * `useWorkflowStream` is the streaming half: it mints the upload id, starts the run
 * on it, sends the file, and wakes the run when the bytes land. `useWorkflowSubmit`
 * is the classic half, and the batch flow is the same hook against a different
 * workflow. Streaming is the DEFAULT because it is faster on any real recording;
 * the classic path stays selectable because it is the shape to read first.
 *
 * ## The third control is about the UPLOAD, not the flow
 *
 * "Split the file across connections" (`parallel`) is orthogonal to the three modes
 * and applies to all of them, which is why it is a checkbox beside the radios
 * rather than a fourth option. The SDK cuts the file into megabyte-aligned parts
 * and sends four at once by DEFAULT, so the checkbox is an opt-OUT — and it is
 * here because this is the template where a reader runs both over the same
 * recording and sees what each costs. Turning it off costs retries as well as
 * speed: a single request is the one upload path that cannot be re-sent.
 *
 * ## The transcript ARRIVES, rather than appearing at the end
 *
 * A run's `output` exists only when its last segment does, so a page with only
 * that shows a status line for the whole fan-out and then everything at once.
 * Each segment is emitted the moment it lands (`emit(TRANSCRIPT_STREAM, …)` in
 * `workflows/transcribe.ts`) and `<LiveTranscript>` in `run-panel.tsx` reads that
 * stream and stitches it with the RUN's own function, so the live text and the
 * stored one cannot drift into two different transcripts of one recording.
 *
 * ## Two waits, two bars, ONE number
 *
 * A recording is the one input big enough that STORING it is itself a wait, and
 * the run does not EXIST until the bytes are in — so `<UploadProgressBar>` covers
 * that stretch and `<WorkflowProgress>` takes over with what the run itself
 * says. The bar also takes the hook's `pauseUpload`/`resumeUpload`: pausing is
 * an abort plus an id, so resuming sends only the windows that did not land —
 * the same mechanism that carries an upload across the agent restarting.
 *
 * Neither bar answers the question a reader comparing the three modes is
 * asking: how long from pressing Transcribe to having a transcript. Nothing on
 * the server can — `output.elapsedMs` is the RUN's own clock and starts after
 * the bytes are stored in two of the three modes. Only the browser holds both
 * ends, which is what `submission.timing` is: a mark at the press and a mark
 * when the run settled. `<TotalLatency>` prints it beside the run's own number.
 *
 * ## A reload keeps two of the three runs, and the third CANNOT be kept
 *
 * `useWorkflowSubmit` keeps a correlation KEY and asks for its newest run on
 * mount, so "after it uploads" and "let the provider do it" come back after a
 * reload with their transcript and log. "While it uploads" does not, and the
 * hook REFUSES the option rather than ignoring it: that run reads an upload this
 * page load is still sending, and `workflows/stream.ts` fails a run whose upload
 * stops growing — so a reload would be watching it die. `<WorkflowPendingNote>`
 * reads each submission's `scope` and says the right sentence for each,
 * including the paused upload.
 *
 * The MODE is remembered too, and that is not decoration: without it a reload
 * opens on the default flow while the recovered run sits behind a radio nobody
 * pressed. `recover.ts` owns the mode, which is this page's own concept, and
 * the validation on the way back out of storage.
 */

import "@alexkroman1/aai-ui/styles.css";
import type { WorkflowNameOf } from "@alexkroman1/aai/workflow-api";
import {
  CheckboxField,
  Form,
  isTerminal,
  mountPage,
  SubmitButton,
  UploadProgressBar,
  useWorkflowRuns,
  useWorkflowStream,
  useWorkflowSubmit,
  WorkflowFields,
  WorkflowPendingNote,
} from "@alexkroman1/aai-ui";
import { useEffect, useState } from "react";
// ERASED at build time: the agent's own type, so every workflow NAME this page
// passes is checked against the `workflows` map `agent.ts` declares.
import type agentDef from "./agent.ts";
import { recalledMode, rememberMode } from "./recover.ts";
// The readouts — one run in flight, every one before it, and the clock. Their
// own module because they are the same whichever of the three hooks produced
// the run; this file owns the page's shape.
import { HISTORY_LIMIT, History, RunPanel, TotalLatency } from "./run-panel.tsx";

/**
 * Which flow the form submits through: the three workflows `agent.ts`
 * declares, by name. `WorkflowNameOf` is the literal union of its `workflows`
 * keys, so a mode the agent does not declare is a compile error here rather
 * than a runtime 400.
 */
type Mode = WorkflowNameOf<typeof agentDef>;

/**
 * What each mode is called, and what picking it changes.
 *
 * The notes are the template's actual subject, so they say what the trade IS rather
 * than which is "best" — the answer depends on the file and the link, and the whole
 * reason all three ship is that a reader can run them over the same recording.
 */
const MODES: readonly { mode: Mode; label: string; note: string }[] = [
  {
    mode: "transcribeStream",
    label: "While it uploads",
    note: "Sync API. The run starts first and transcribes each segment as its bytes land, so progress is visible while the file is still moving — but the run is reading the file from this page, so it cannot survive a reload.",
  },
  {
    mode: "transcribe",
    label: "After it uploads",
    note: "Sync API. Store the whole recording, then fan out over it. The simplest shape, and the quickest on a fast link.",
  },
  {
    mode: "transcribeBatch",
    label: "Let the provider do it",
    note: "Async API. One job, no cutting, no seams — and it accepts MP3 and M4A, which the two above refuse.",
  },
];

/** Just the mode names, for the recall to check a stored value against. */
const MODE_NAMES: readonly Mode[] = MODES.map((option) => option.mode);

function TranscriptionDesk() {
  // The mode the last submission used, so a recovered run is in front of the
  // reader rather than behind a radio nobody pressed. Lazy, and validated on the
  // way out of storage — see `recalledMode`.
  const [mode, setMode] = useState<Mode>(() => recalledMode(MODE_NAMES, "transcribeStream"));
  // Whether the browser cuts the recording up and sends the pieces at once. One
  // piece of state for all three hooks, because it describes the UPLOAD and every
  // mode has one — see the module doc.
  const [parallel, setParallel] = useState(true);
  // ALL THREE hooks are called every render, because a hook may not be conditional —
  // and that costs nothing: none of them does anything until its `submit` is called.
  // The two submit hooks recover unconditionally rather than on `mode === …`: the
  // lookup is a MOUNT-time act, and `find` is scoped by workflow as well as by key,
  // so the two modes recover separate runs. The streaming hook refuses `recover` by
  // type, and mints no key it would never read back.
  const streamed = useWorkflowStream<typeof agentDef, "transcribeStream">("transcribeStream", {
    parallel,
  });
  const stored = useWorkflowSubmit<typeof agentDef, "transcribe">("transcribe", { parallel });
  const batched = useWorkflowSubmit<typeof agentDef, "transcribeBatch">("transcribeBatch", {
    parallel,
  });
  // Everything below reads the ACTIVE hook — `startedHere`, `scope` and `timing`
  // included — so switching modes shows the truth about the run being shown
  // rather than one page-wide flag that survived the switch.
  const active =
    mode === "transcribeStream" ? streamed : mode === "transcribeBatch" ? batched : stored;
  const { submitForm, run, upload, pending, error, reset, pauseUpload, resumeUpload } = active;
  // History is per WORKFLOW, so the list follows the mode: two flows that produce
  // the same output are still two different things to have run.
  const history = useWorkflowRuns<typeof agentDef>(mode, { limit: HISTORY_LIMIT });
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
          Upload a recording. It is split into chunks, transcribed chunk by chunk, and stitched back
          together by a durable workflow — which outlives this page, and which two of the three
          flows below can pick up again after a reload.
        </p>
      </header>

      <ModePicker mode={mode} onPick={setMode} disabled={pending} />

      <UploadPicker parallel={parallel} onPick={setParallel} disabled={pending} />

      {/* No mapping: the collected values already match the input schema. All three
          workflows declare `recording` as an upload, so the same picker serves every
          mode — how the bytes travel is not a question to ask a person. */}
      <Form
        onSubmit={(values) => {
          // Written at SUBMIT rather than on the radio, so the remembered mode
          // is always the mode a run exists under — which is the only thing the
          // next load can use it for.
          rememberMode(mode);
          return submitForm(values);
        }}
        error={error}
      >
        {/* The NAME, so the schema is fetched here rather than by this page. */}
        <WorkflowFields<typeof agentDef> workflow={mode} />
        {/* Unguarded on purpose: it renders nothing until there are bytes in
            flight, and nothing again once they have landed. */}
        <UploadProgressBar upload={upload} onPause={pauseUpload} onResume={resumeUpload} />
        <SubmitButton pending={pending}>Transcribe</SubmitButton>
      </Form>

      <TotalLatency
        timing={active.timing}
        runMs={run?.status === "completed" ? run.output.elapsedMs : undefined}
      />

      {/* One sentence about the wait, from the ACTIVE submission's own `scope`
          and `upload`: "keep this tab open" for a streaming run, the paused
          upload's own line, and the reload copy for the two modes that recover. */}
      <WorkflowPendingNote submission={active} subject="transcript" />

      {run && (
        <RunPanel
          run={run}
          onClear={() => {
            // A recovered run is dismissed as deliberately as one this load
            // started: the lookup is a mount-time act, so `reset()` is not
            // undone by a second one and Clear really does clear.
            reset();
          }}
        />
      )}

      <History
        history={history}
        openId={openId}
        onOpen={(runId) => setOpenId((current) => (current === runId ? undefined : runId))}
      />
    </main>
  );
}

/**
 * Which flow submits, as three radios.
 *
 * Radios rather than a toggle or a select, because the choice has a REASON per
 * option and a radio group is the one control with room to show it.
 *
 * Disabled while a submission is in flight: the hooks hold separate run state,
 * so switching mid-run would swap the panel for the other hook's (empty) one and
 * read as the run having vanished.
 */
function ModePicker({
  mode,
  onPick,
  disabled,
}: {
  mode: Mode;
  onPick: (next: Mode) => void;
  disabled: boolean;
}) {
  return (
    <fieldset className="flex flex-col gap-3" disabled={disabled}>
      <legend className="text-sm font-medium uppercase tracking-[1.2px]">Transcribe</legend>
      {MODES.map((option) => (
        <label key={option.mode} className="flex items-start gap-3 text-sm">
          <input
            type="radio"
            name="mode"
            className="mt-1"
            value={option.mode}
            checked={mode === option.mode}
            onChange={() => onPick(option.mode)}
          />
          <span className="flex flex-col gap-0.5">
            <span>{option.label}</span>
            <span className="text-xs opacity-70">{option.note}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

/**
 * How the recording travels, as one checkbox.
 *
 * Beside the mode radios rather than among them because it answers a different
 * question — those pick the WORKFLOW, this picks how its input gets there — and
 * every mode is uploading a file either way. Disabled mid-submission for the
 * same reason the radios are: the bytes are already moving.
 */
function UploadPicker({
  parallel,
  onPick,
  disabled,
}: {
  parallel: boolean;
  onPick: (next: boolean) => void;
  disabled: boolean;
}) {
  return (
    <fieldset className="flex flex-col gap-3" disabled={disabled}>
      <legend className="text-sm font-medium uppercase tracking-[1.2px]">Upload</legend>
      {/* `<CheckboxField>` is what `<WorkflowFields>` renders for a declared
          boolean, so the one control this page writes itself matches the ones
          its schema declares. It sits OUTSIDE `<Form>` deliberately: `parallel`
          describes how the recording travels rather than what the workflow is
          asked for, so it is page state and the `name` is for the DOM. */}
      <CheckboxField
        name="parallel"
        label="Split the file across connections"
        hint="Sends the recording as several parts at once instead of in one request, which is most of the wait on a long file — and is the only upload a dropped connection can resume. Falls back to the single request on a small one."
        checked={parallel}
        onChange={(event) => onPick(event.target.checked)}
      />
    </fieldset>
  );
}

mountPage({ name: "Transcription Desk", component: TranscriptionDesk });
