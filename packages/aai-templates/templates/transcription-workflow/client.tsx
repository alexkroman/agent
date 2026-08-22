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
 * `useWorkflowStream` is the streaming half: it mints the upload id, starts the run
 * on it, sends the file, and wakes the run when the bytes land. `useWorkflowSubmit`
 * is the classic half and is unchanged.
 *
 * Streaming is the DEFAULT because it is faster on any real recording. The classic
 * path stays selectable because it is the shape to read first.
 *
 * ## The third control is about the UPLOAD, not the flow
 *
 * "Split the file across connections" (`parallel`) is orthogonal to the three modes
 * and applies to all of them, which is why it is a checkbox beside the radios
 * rather than a fourth option. A single request moves a file at one connection's
 * throughput, which over any distance is a fraction of the link — so the SDK cuts
 * the file into megabyte-aligned parts and sends four at once. Nothing about the
 * workflow changes: the agent reassembles them, `readUpload` reads the same
 * windows, and the streaming flow still watches the file grow (what it polls is the
 * CONTIGUOUS prefix, which is honest whether one connection or four are filling
 * it).
 *
 * The SDK does this by DEFAULT, so the checkbox is an opt-OUT rather than an
 * opt-in — and it is here for the reason the mode radios are: this is the template
 * where a reader runs both over the same recording and sees what each costs. It
 * also degrades on its own — a small file, or an agent deployed before the
 * `/parts` routes existed, sends the single request instead — so leaving it on is
 * safe, and turning it off costs retries as well as speed (a single request is the
 * one upload path that cannot be re-sent).
 *
 * ## The transcript ARRIVES, rather than appearing at the end
 *
 * A run's `output` exists only when its last segment does, so a page with only
 * that shows a status line for the whole fan-out and then everything at once — on
 * a 97-minute recording, minutes of it. Each segment is emitted the moment it
 * lands (`emit(TRANSCRIPT_STREAM, …)` in `workflows/transcribe.ts`) and
 * `useWorkflowProgress` reads that stream, so the panel renders the transcript
 * growing.
 *
 * Three things make it honest rather than decorative:
 *
 * - **The page stitches with the RUN's own function.** `stitchChunks` is
 *   `workflows/stitch.ts`, imported by both, so the live text and the stored one
 *   cannot drift into two different transcripts of one recording.
 * - **It is a SEPARATE stream from the progress log.** `report()`'s lines go to
 *   the default one, which `<WorkflowProgress>` renders verbatim; objects in
 *   there would come out as `[object Object]` between the sentences.
 * - **The finished run wins.** Once `output` exists the panel renders that
 *   instead — it is the authoritative text, counted and measured, and a live
 *   transcript that stayed on screen beside it would be a second answer with no
 *   way to tell which was current.
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
 *
 * ## A long upload can be PAUSED, and survives the agent restarting
 *
 * The same wait is the one thing on this page a person may want to interrupt: a
 * 600 MB recording is minutes of a laptop's uplink, and needing it back for a
 * call should not cost the upload. So `<UploadProgressBar>` takes the hook's
 * `pauseUpload`/`resumeUpload` and draws a button — every mode, because every
 * mode is sending a file.
 *
 * **Nothing in this template implements it**, which is the part worth reading.
 * Pausing is an abort plus an id: the windows already sent are stored under an
 * upload id the hook minted, so resuming reads back which ranges landed and sends
 * only the rest. That is the same mechanism the SDK uses on its own when a round
 * fails for a reason that looks like an outage — a redeploy, a sandbox reclaimed
 * on idle, `aai dev` restarting on a save — so an agent that goes away mid-upload
 * is a pause nobody asked for, and the upload picks up where it stopped.
 *
 * The two flows differ in what a pause costs, and only in that:
 *
 * - **"After it uploads"** and **"the async API"** have no run yet, so a pause
 *   costs nothing at all. The form simply has not been submitted.
 * - **"While it uploads"** has a run watching the id already, and to a run a
 *   paused upload is one whose `size` stopped growing — which is exactly what a
 *   slow uplink looks like. `workflows/stream.ts` gives that five minutes
 *   (`MAX_IDLE_POLLS`) before it calls the uploader gone and fails the run, so a
 *   pause longer than a coffee ends the run rather than the upload.
 *
 * ## Two waits, ONE number
 *
 * The two bars describe the two stretches separately, and neither answers the
 * question a reader comparing the three modes is actually asking: how long from
 * pressing Transcribe to having a transcript. Nothing on the server can answer it
 * either — `output.elapsedMs` is the RUN's own wall clock, so it starts after the
 * bytes are stored in two of the three modes and misses the whole upload, which is
 * most of the wait on a long file over a slow link. Only the browser holds both
 * ends, so `useTotalLatency` is a stopwatch here: started by the submit, ticking
 * across the upload and the run alike, and frozen the moment the run settles.
 *
 * `<TotalLatency>` also prints the SPLIT once the run reports its own elapsed —
 * before the run and inside it — because the two numbers on screen otherwise
 * disagree with no way to see why, and their difference is exactly what picking a
 * mode or unchecking `parallel` moves.
 */

import "@alexkroman1/aai-ui/styles.css";
import type { WorkflowOutputOf } from "@alexkroman1/aai/workflow-api";
import {
  Form,
  isTerminal,
  page,
  SubmitButton,
  UploadProgressBar,
  useWorkflowProgress,
  useWorkflowRuns,
  useWorkflowStream,
  useWorkflowSubmit,
  WorkflowFields,
  WorkflowProgress,
  type WorkflowRun,
} from "@alexkroman1/aai-ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { transcribe } from "./agent.ts";
import {
  clock,
  countWords,
  stitchChunks,
  TRANSCRIPT_STREAM,
  type TranscriptChunk,
} from "./workflows/stitch.ts";

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

/**
 * How often the running stopwatch re-renders.
 *
 * Under a second, so the displayed seconds turn over promptly rather than up to a
 * second late; nothing reads this value, since the elapsed time is measured from
 * the clock at render (see {@link useTotalLatency}).
 */
const STOPWATCH_TICK_MS = 250;

/** What {@link useTotalLatency} reports. */
type TotalLatency = {
  /**
   * Milliseconds since the submit — ticking while the submission is in flight,
   * frozen at the finish, and undefined before the first one.
   */
  elapsedMs: number | undefined;
  /** Whether the clock is still running, which is what makes the label honest. */
  running: boolean;
  /** Start (or restart) the clock. Called from the form's own submit handler. */
  start: () => void;
  /** Drop it, for a panel that no longer describes the submission it timed. */
  clear: () => void;
};

/**
 * Wall clock from the submit to the finish, across both waits.
 *
 * `inFlight` is the submission's own `pending` — true from `submit()` until the run
 * reaches a terminal status — so the clock covers the upload, the run, and the
 * gap between them, which is the whole of what a reader waits for and is the one
 * measurement no server-side number can make.
 *
 * Two details it would be easy to get wrong:
 *
 * - **The interval re-renders; it does not accumulate.** The elapsed time is read
 *   from the clock at render, so a tick the tab throttled or dropped cannot make
 *   the number lag behind real time.
 * - **`performance.now()`, not `Date.now()`.** It is monotonic, so a clock
 *   correction (NTP, a laptop waking up) cannot make a transcription look
 *   instant — or negative.
 */
function useTotalLatency(inFlight: boolean): TotalLatency {
  const [startedAt, setStartedAt] = useState<number | undefined>(undefined);
  const [frozenMs, setFrozenMs] = useState<number | undefined>(undefined);
  // Re-render trigger only — see the doc above.
  const [, tick] = useState(0);
  // Whether `inFlight` has been seen true since the last `start()`. Without it,
  // a start that lands one render before the submission reports itself in flight
  // would freeze the clock at zero instead of running it.
  const began = useRef(false);

  useEffect(() => {
    if (startedAt === undefined || frozenMs !== undefined) return;
    if (inFlight) {
      began.current = true;
      const id = setInterval(() => tick((n) => n + 1), STOPWATCH_TICK_MS);
      return () => clearInterval(id);
    }
    // Measured here rather than at render, so the frozen number is the one at the
    // moment the run settled rather than whenever this page next drew.
    if (began.current) setFrozenMs(performance.now() - startedAt);
  }, [startedAt, frozenMs, inFlight]);

  const start = useCallback(() => {
    began.current = false;
    setFrozenMs(undefined);
    setStartedAt(performance.now());
  }, []);

  const clear = useCallback(() => {
    began.current = false;
    setStartedAt(undefined);
    setFrozenMs(undefined);
  }, []);

  return {
    elapsedMs: frozenMs ?? (startedAt === undefined ? undefined : performance.now() - startedAt),
    running: startedAt !== undefined && frozenMs === undefined,
    start,
    clear,
  };
}

/**
 * The one number the two bars cannot give: click to transcript.
 *
 * Rendered above the run panel rather than inside it, because the stretch it
 * covers starts before there IS a run — in two of the three modes the run does
 * not exist until the upload finishes, so a clock living in the panel would
 * appear only after the wait it is supposed to be timing.
 *
 * `runMs` is the run's own elapsed, once it reports one. The remainder is
 * everything the run could not see: storing the file (or, in streaming mode,
 * minting the upload id), the `POST` that starts the run, and the poll that
 * notices it finished. Clamped at zero, because the two numbers come from two
 * different clocks on two different machines and a few milliseconds the wrong way
 * would otherwise print a negative.
 */
function TotalLatency({
  elapsedMs,
  running,
  runMs,
}: {
  elapsedMs: number | undefined;
  running: boolean;
  runMs: number | undefined;
}) {
  if (elapsedMs === undefined) return null;
  const outside = runMs === undefined ? undefined : Math.max(0, elapsedMs - runMs);
  return (
    <section className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 rounded-md border px-5 py-3">
      <h2 className="text-sm font-medium uppercase tracking-[1.2px]">
        {running ? "Elapsed" : "Total latency"}
      </h2>
      <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-sm tabular-nums">{duration(elapsedMs)}</span>
        {runMs !== undefined && outside !== undefined && (
          <span className="text-xs tabular-nums opacity-60">
            {duration(outside)} before the run · {duration(runMs)} inside it
          </span>
        )}
      </span>
    </section>
  );
}

function TranscriptionDesk() {
  const [mode, setMode] = useState<Mode>("streaming");
  // Whether the browser cuts the recording up and sends the pieces at once. One
  // piece of state for all three hooks, because it describes the UPLOAD and every
  // mode has one — see the module doc.
  const [parallel, setParallel] = useState(true);
  // ALL THREE hooks are called every render, because a hook may not be conditional —
  // and that costs nothing here: none of them does anything until its `submit` is
  // called, and `useWorkflowRun` underneath them holds no id until then either.
  const streamed = useWorkflowStream<Transcript>(WORKFLOWS.streaming, { parallel });
  const stored = useWorkflowSubmit<Transcript>(WORKFLOWS.classic, { parallel });
  const batched = useWorkflowSubmit<Transcript>(WORKFLOWS.batch, { parallel });
  // The batch flow uploads the same way the classic one does — the id comes from the
  // store — so it is the SAME hook against a different workflow. Only the streaming
  // mode needs the other one, because only it needs the id before the bytes.
  const active = mode === "streaming" ? streamed : mode === "batch" ? batched : stored;
  const { submit, run, upload, pending, error, reset, pauseUpload, resumeUpload } = active;
  // History is per WORKFLOW, so the list follows the mode: two flows that produce
  // the same output are still two different things to have run, and merging them
  // would put a run under a heading that cannot explain it.
  const history = useWorkflowRuns<Transcript>(WORKFLOWS[mode], { limit: HISTORY_LIMIT });
  // Which past run the reader is looking at, if any. Its own state rather than
  // a route, because a workflow app is one page and a run id is not a place.
  const [openId, setOpenId] = useState<string | undefined>(undefined);
  // Click to transcript, measured here because only the browser sees both ends.
  const total = useTotalLatency(pending);

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

      {/* The clock goes with the mode: switching swaps `active` for another hook's
          run, and a total measured over a different submission would be a number
          for something the panel below is no longer showing. */}
      <ModePicker
        mode={mode}
        onPick={(next) => {
          setMode(next);
          total.clear();
        }}
        disabled={pending}
      />

      <UploadPicker parallel={parallel} onPick={setParallel} disabled={pending} />

      {/* No mapping: the collected values already match the input schema. All three
          workflows declare `recording` as an upload, so the same picker serves every
          mode — how the bytes travel is not a question to ask a person. */}
      {/* The clock starts HERE, which is as close to the press as a page can get:
          `<Form>` calls this once the browser's own validation has passed and it has
          read the controls, and an upload field contributes its `File` unread — so
          what separates this line from the click is a microtask, not the file. */}
      <Form
        onSubmit={(values) => {
          total.start();
          return submit(values);
        }}
        error={error}
      >
        {/* The NAME, so the schema is fetched here rather than by this page. */}
        <WorkflowFields workflow={WORKFLOWS[mode]} />
        {/* Unguarded on purpose: it renders nothing until there are bytes in
            flight, and nothing again once they have landed. The handlers are what
            turn the bar into a control — see "A long upload can be PAUSED" above;
            all three hooks expose the same pair, so `active` needs no branch. */}
        <UploadProgressBar upload={upload} onPause={pauseUpload} onResume={resumeUpload} />
        <SubmitButton pending={pending}>Transcribe</SubmitButton>
      </Form>

      <TotalLatency
        elapsedMs={total.elapsedMs}
        running={total.running}
        runMs={run?.status === "completed" ? run.output.elapsedMs : undefined}
      />

      {run && (
        <RunPanel
          run={run}
          onClear={() => {
            reset();
            total.clear();
          }}
        />
      )}

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
 * How the recording travels, as one checkbox.
 *
 * Beside the mode radios rather than among them because it answers a different
 * question — those pick the WORKFLOW, this picks how its input gets there — and
 * every mode is uploading a file either way.
 *
 * Disabled mid-submission for the same reason the radios are: the bytes are
 * already moving, and a control that looks live while changing nothing is worse
 * than one that is plainly unavailable.
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
      <label className="flex items-start gap-3 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          name="parallel"
          checked={parallel}
          onChange={(event) => onPick(event.target.checked)}
        />
        <span className="flex flex-col gap-0.5">
          <span>Split the file across connections</span>
          <span className="text-xs opacity-70">
            Sends the recording as several parts at once instead of in one request, which is most of
            the wait on a long file — and is the only upload a dropped connection can resume. Falls
            back to the single request on a small one.
          </span>
        </span>
      </label>
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

      {/* While it runs, the transcript so far. Unguarded on the run's status
          beyond this: the component renders nothing until a segment has landed,
          and stops the moment there is an `output` to render instead. */}
      {!isTerminal(run) && <LiveTranscript runId={run.runId} />}

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
 * The transcript as it arrives, stitched from the segments that have landed.
 *
 * The other half of `<WorkflowProgress>` above it: that one renders what the run
 * SAYS about itself, this one renders what it has produced. Both are the same
 * mechanism — a run's output stream — separated by the namespace, which is what
 * lets this one be typed.
 *
 * It renders NOTHING until a segment lands, so a page can mount it unguarded:
 * before the first chunk there is nothing to say that the progress log is not
 * already saying better.
 *
 * The count is derived from the stitched text rather than summed per chunk,
 * because the seams overlap — adding up the segments would over-count every one
 * of them by a couple of seconds' worth of words.
 */
function LiveTranscript({ runId }: { runId: string }) {
  const { progress } = useWorkflowProgress<TranscriptChunk>(runId, {
    namespace: TRANSCRIPT_STREAM,
  });
  // Memoized on the ARRAY, which the hook appends to per read: stitching is a
  // seam search per segment, and a fan-out re-renders this panel on every
  // progress poll whether or not anything arrived.
  const transcript = useMemo(() => stitchChunks(progress), [progress]);
  if (progress.length === 0) return null;

  // The furthest point reached, not the count: segments land out of order, so
  // "6 segments" says nothing about how much of the recording is covered.
  const covered = Math.max(...progress.map((chunk) => chunk.endMs));
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs opacity-60">
        {countWords(transcript)} words so far · through {clock(covered)}
      </p>
      <pre className="whitespace-pre-wrap text-sm leading-relaxed opacity-80">{transcript}</pre>
    </div>
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
