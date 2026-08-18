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
 * ## Two modes, and the toggle is the template's subject
 *
 * The desk offers both flows the agent declares, and the page is where the
 * difference is legible: pick "while it uploads" and there is a run to watch
 * before any bytes are in, pick "after it uploads" and there is not. They share
 * everything else — one `<Form>`, one picker, one progress log, one transcript —
 * because they take the same input and return the same shape, and the only thing
 * the page chooses is which HOOK submits it.
 *
 * `useWorkflowStream` is the streaming half: it cuts the file with the cutter this
 * template supplies (`cut-wav.ts`, which is `workflows/wav.ts` run in the browser),
 * uploads each part under one group token, and wakes the run as each lands.
 * `useWorkflowSubmit` is the classic half and is unchanged.
 *
 * Streaming is the DEFAULT because it is faster on any real recording. The classic
 * path stays selectable because it is the shape to read first, and because it is
 * the one that works on a file this browser cannot parse — the cutter needs a WAV
 * header, where the server-side flow reaches the same conclusion in its first step.
 *
 * ## Two waits, two bars
 *
 * A recording is the one input big enough that STORING it is itself a wait, and
 * it is a wait nothing else on this page can describe: the run does not EXIST
 * until the bytes are in, so there is no run id, no status and nothing for
 * `<WorkflowProgress>` to read. `<UploadProgressBar>` covers exactly that
 * stretch — `useWorkflowSubmit` reports the bytes as they go and drops the
 * report the moment the last one lands — and `<WorkflowProgress>` takes over
 * from there with what the run itself says. A page with only the second showed a
 * disabled button and nothing else for the length of the upload.
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
  UploadProgressBar,
  useWorkflowRuns,
  useWorkflowStream,
  useWorkflowSubmit,
  WorkflowFields,
  WorkflowProgress,
  type WorkflowRun,
} from "@alexkroman1/aai-ui";
import { useEffect, useState } from "react";
import type { transcribe } from "./agent.ts";
import { ApiHelp } from "./api-help.tsx";

/**
 * What a finished run reports.
 *
 * Derived from the workflow declaration rather than restated — `import type` is
 * erased, so naming `transcribe` here bundles none of the agent, the SDK, or the
 * workflow body into this page.
 */
type Transcript = WorkflowOutputOf<typeof transcribe>;

/**
 * The three workflows this page drives, keyed by the mode that picks one.
 *
 * The STRINGS matter: a page starts a run by name, so a rename in `agent.ts` is a
 * runtime 400 rather than a compile error. `agent.test.ts` pins all three.
 */
const WORKFLOWS = {
  streaming: "transcribeStream",
  classic: "transcribe",
  batch: "transcribeBatch",
} as const;

/** Which flow the form submits through. */
type Mode = keyof typeof WORKFLOWS;

/**
 * What each mode is called, and what picking it changes.
 *
 * The notes are the template's actual subject, so they say what the trade IS rather
 * than which is "best" — the answer depends on the file and the link, and the whole
 * reason all three ship is that a reader can run them over the same recording.
 */
const MODES: readonly { mode: Mode; label: string; note: string }[] = [
  {
    mode: "streaming",
    label: "While it uploads",
    note: "Sync API. The run starts first and transcribes each segment as its bytes land, so progress is visible while the file is still moving.",
  },
  {
    mode: "classic",
    label: "After it uploads",
    note: "Sync API. Store the whole recording, then fan out over it. The simplest shape, and the quickest on a fast link.",
  },
  {
    mode: "batch",
    label: "Let the provider do it",
    note: "Async API. One job, no cutting, no seams — and it accepts MP3 and M4A, which the two above refuse.",
  },
];

/** Most past runs the history list shows. */
const HISTORY_LIMIT = 10;

function TranscriptionDesk() {
  const [mode, setMode] = useState<Mode>("streaming");
  // ALL THREE hooks are called every render, because a hook may not be conditional —
  // and that costs nothing here: none of them does anything until its `submit` is
  // called, and `useWorkflowRun` underneath them holds no id until then either.
  const streamed = useWorkflowStream<Transcript>(WORKFLOWS.streaming);
  const stored = useWorkflowSubmit<Transcript>(WORKFLOWS.classic);
  const batched = useWorkflowSubmit<Transcript>(WORKFLOWS.batch);
  // The batch flow uploads the same way the classic one does — the id comes from the
  // store — so it is the SAME hook against a different workflow. Only the streaming
  // mode needs the other one, because only it needs the id before the bytes.
  const active = mode === "streaming" ? streamed : mode === "batch" ? batched : stored;
  const { submit, run, upload, pending, error, reset } = active;
  // History is per WORKFLOW, so the list follows the mode: two flows that produce
  // the same output are still two different things to have run, and merging them
  // would put a run under a heading that cannot explain it.
  const history = useWorkflowRuns<Transcript>(WORKFLOWS[mode], { limit: HISTORY_LIMIT });
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

      <ModePicker mode={mode} onPick={setMode} disabled={pending} />

      {/* No mapping: the collected values already match the input schema. All three
          workflows declare `recording` as an upload, so the same picker serves every
          mode — how the bytes travel is not a question to ask a person. */}
      <Form onSubmit={(values) => submit(values)} error={error}>
        {/* The NAME, so the schema is fetched here rather than by this page. */}
        <WorkflowFields workflow={WORKFLOWS[mode]} />
        {/* Unguarded on purpose: it renders nothing until there are bytes in
            flight, and nothing again once they have landed. */}
        <UploadProgressBar upload={upload} />
        <SubmitButton pending={pending}>Transcribe</SubmitButton>
      </Form>

      {run && <RunPanel run={run} onClear={reset} />}

      <History
        runs={history.runs}
        error={history.error}
        openId={openId}
        onOpen={(runId) => setOpenId((current) => (current === runId ? undefined : runId))}
      />

      {/* The most useful thing about a workflow app is the least discoverable:
          this page is one caller of an ordinary HTTP API. See `api-help.tsx`. */}
      <ApiHelp />
    </main>
  );
}

/**
 * Which flow submits, as two radios.
 *
 * Radios rather than a toggle or a select, because the choice has a REASON per
 * option and a radio group is the one control with room to show it — the note
 * under each label is what makes this a decision rather than a switch somebody
 * flips to see what happens.
 *
 * Disabled while a submission is in flight: the two hooks hold separate run state,
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
            {run.output.segments} {run.output.segments === 1 ? "segment" : "segments"} ·{" "}
            {duration(run.output.durationMs)} of audio · took {duration(run.output.elapsedMs)} ·{" "}
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
 * A duration a person can read.
 *
 * `${Math.round(ms / 1000)}s` was what this printed, and an hour-long recording came
 * out as `3746s` — which a reader asked whether they should parse as 37.46 seconds.
 * A raw second count stops being readable at about ninety of them, and the recordings
 * this desk is FOR are the ones past that.
 *
 * The hours component is omitted when it is zero rather than padded to `0:02:26`, so
 * a two-minute clip reads as `2:26` and only a long one grows a field.
 */
function duration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const seconds = String(total % 60).padStart(2, "0");
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
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
