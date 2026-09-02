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
 * ends, so `total-latency.tsx` is a stopwatch: `useTotalLatency` is started by
 * the submit, ticks across the upload and the run alike, and freezes the moment
 * the run settles.
 *
 * `<TotalLatency>` also prints the SPLIT once the run reports its own elapsed —
 * before the run and inside it — because the two numbers on screen otherwise
 * disagree with no way to see why, and their difference is exactly what picking a
 * mode or unchecking `parallel` moves.
 *
 * ## A reload keeps two of the three runs, and the third CANNOT be kept
 *
 * The run id lives in React state, so a refresh loses it while the fan-out
 * carries on. `key` is the handle that survives that and `recover: true` is what
 * reads it back — and here it is a decision PER MODE rather than per page:
 *
 * - **"After it uploads"** and **"Let the provider do it"** recover. Their input
 *   names a recording that is already stored, so a later load adopting the run
 *   is adopting something complete: the transcript arrives, the progress log
 *   replays, and nobody is asked to send a 600 MB file a second time.
 * - **"While it uploads" does not, and the hook REFUSES the option rather than
 *   ignoring it.** That run's input names an upload id this page load minted and
 *   is still filling, so a later load could only adopt a run waiting for bytes
 *   nobody is sending — and it is worse than useless: `workflows/stream.ts`
 *   fails a run whose upload stops growing (`MAX_IDLE_POLLS`), so the reload
 *   that "recovered" it would be watching it die. Streaming runs are still in
 *   Previous runs below, which is where a run this page cannot hold belongs.
 *
 * The MODE is remembered too, and that is not decoration: without it a reload
 * opens on the default flow while the recovered run sits behind a radio nobody
 * pressed, so the reader sees an empty form and starts a second run — the exact
 * thing the key exists to prevent. The KEY is `useRunKey()`, which owns the
 * minting, the storage and the argument for the key being opaque rather than a
 * `?key=` parameter; `recover.ts` owns the mode, which is this page's own
 * concept, and the validation on the way back out of storage that turning a
 * stored string into a workflow name obliges.
 *
 * Two smaller consequences worth knowing. Both recovering hooks look up on
 * mount, so a load costs two `find` requests on a page that was already reading
 * a run listing — cheap, and the alternative (arming the lookup when a mode is
 * picked) would re-adopt a run the reader had just cleared, because the lookup
 * is deliberately a mount-time act. And `<TotalLatency>` shows nothing for a
 * recovered run: the stopwatch is a browser clock and the browser it was
 * running on is gone, which is more honest than a total measured from the reload.
 */

import "@alexkroman1/aai-ui/styles.css";
import {
  Form,
  isTerminal,
  page,
  SubmitButton,
  UploadProgressBar,
  useRunKey,
  useWorkflowRuns,
  useWorkflowStream,
  useWorkflowSubmit,
  WorkflowFields,
} from "@alexkroman1/aai-ui";
import { useEffect, useState } from "react";
import type { transcribe } from "./agent.ts";
import { pendingNote, recalledMode, rememberMode } from "./recover.ts";
// The readouts — one run in flight, and every one before it. Their own module
// because they are the same whichever of the three hooks produced the run; this
// file owns the page's shape.
import { HISTORY_LIMIT, History, RunPanel, type Transcript } from "./run-panel.tsx";
// The stopwatch and the section that prints it. See its module doc for why the
// one number a reader wants can only be measured here.
import { TotalLatency, useTotalLatency } from "./total-latency.tsx";

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
    note: "Sync API. The run starts first and transcribes each segment as its bytes land, so progress is visible while the file is still moving — but the run is reading the file from this page, so it cannot survive a reload.",
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

/**
 * Just the mode names, for the recall to check a stored value against.
 *
 * Derived from `MODES` rather than written out again: a fourth flow then joins
 * the recall by joining that list, and the two cannot disagree about what a
 * mode is.
 */
const MODE_NAMES: readonly Mode[] = MODES.map((option) => option.mode);

function TranscriptionDesk() {
  // The mode the last submission used, so a recovered run is in front of the
  // reader rather than behind a radio nobody pressed. Lazy, and validated on the
  // way out of storage — see `recalledMode`.
  const [mode, setMode] = useState<Mode>(() => recalledMode(MODE_NAMES, "streaming"));
  // Whether the browser cuts the recording up and sends the pieces at once. One
  // piece of state for all three hooks, because it describes the UPLOAD and every
  // mode has one — see the module doc.
  const [parallel, setParallel] = useState(true);
  // This tab's handle on its own runs — minted once and remembered, which is
  // what a later load produces to find the run again.
  const key = useRunKey();
  // Did THIS load press Transcribe? A reload cannot have, and it is the only way
  // the page can tell "working on what you just sent" from "picking up where you
  // left off" — the hooks report the run, not who asked for it.
  const [startedHere, setStartedHere] = useState(false);
  // ALL THREE hooks are called every render, because a hook may not be conditional —
  // and that costs nothing here: none of them does anything until its `submit` is
  // called, and `useWorkflowRun` underneath them holds no id until then either.
  //
  // `recover` is a constant `true` on the two that take it rather than
  // `mode === …`: the lookup is a MOUNT-time act, so arming it when a mode is
  // picked would re-adopt a run the reader had just cleared. The streaming hook
  // takes neither half — it refuses `recover` by type, and recording a key it
  // will never read back would be config nothing uses.
  const streamed = useWorkflowStream<typeof transcribe>(WORKFLOWS.streaming, { parallel });
  const stored = useWorkflowSubmit<typeof transcribe>(WORKFLOWS.classic, {
    parallel,
    key,
    recover: true,
  });
  const batched = useWorkflowSubmit<typeof transcribe>(WORKFLOWS.batch, {
    parallel,
    key,
    recover: true,
  });
  // The batch flow uploads the same way the classic one does — the id comes from the
  // store — so it is the SAME hook against a different workflow. Only the streaming
  // mode needs the other one, because only it needs the id before the bytes.
  const active = mode === "streaming" ? streamed : mode === "batch" ? batched : stored;
  const { submitForm, run, upload, pending, error, reset, pauseUpload, resumeUpload } = active;
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
          back together by a durable workflow — which outlives this page, and which two of the three
          flows below can pick up again after a reload.
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
          setStartedHere(true);
          // Written at SUBMIT rather than on the radio, so the remembered mode
          // is always the mode a run exists under — which is the only thing the
          // next load can use it for.
          rememberMode(mode);
          return submitForm(values);
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

      {/* One sentence about the wait, and the only place the three modes differ
          in what a reader may DO: `pending` is also true on a reload while the
          run is being looked up by key, which is the stretch where an empty form
          would invite a second upload of the same recording. */}
      {pending && (
        <p className="text-sm opacity-70">
          {pendingNote({
            recoverable: mode !== "streaming",
            startedHere,
            found: run !== undefined,
          })}
        </p>
      )}

      {run && (
        <RunPanel
          run={run}
          onClear={() => {
            // A recovered run is dismissed as deliberately as one this load
            // started: the lookup is a mount-time act, so `reset()` is not
            // undone by a second one and Clear really does clear.
            setStartedHere(false);
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

page({ name: "Transcription Desk", component: TranscriptionDesk });
