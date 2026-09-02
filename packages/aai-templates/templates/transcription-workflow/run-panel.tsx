// Copyright 2026 the AAI authors. MIT license.
/**
 * What a run LOOKS like — one in flight, and every one before it.
 *
 * `client.tsx` owns the page's shape: the form, the three hooks, the mode, and
 * which of them is active. This module owns the readouts, which are the same
 * whichever hook produced the run — a `WorkflowRun<Transcript>` is a
 * `WorkflowRun<Transcript>` whether it arrived from `useWorkflowStream`,
 * `useWorkflowSubmit` or the history listing, which is exactly why `<RunPanel>`
 * serves both the live run and an expanded past one.
 *
 * Three components, in the order a reader meets them:
 *
 * - **`<RunPanel>`** — the status, the narration, and the transcript once there
 *   is one.
 * - **`<LiveTranscript>`** — the transcript as it ARRIVES, which is what makes a
 *   sixty-segment fan-out watchable.
 * - **`<History>`** — every recent run, newest first.
 */

import { countWords, formatDuration, plural } from "@alexkroman1/aai/utils";
import type { WorkflowOutputOf } from "@alexkroman1/aai/workflow-api";
import {
  isTerminal,
  useWorkflowProgress,
  WORKFLOW_STATUS_LABELS,
  WorkflowProgress,
  type WorkflowRun,
} from "@alexkroman1/aai-ui";
import { useMemo } from "react";
import type { transcribe } from "./agent.ts";
import { stitchChunks, TRANSCRIPT_STREAM, type TranscriptChunk } from "./workflows/stitch.ts";

/**
 * What a finished run reports.
 *
 * Derived from the workflow declaration rather than restated — `import type` is
 * erased, so naming `transcribe` here bundles none of the agent, the SDK, or the
 * workflow body into this page.
 */
export type Transcript = WorkflowOutputOf<typeof transcribe>;

/** Most past runs the history list shows. */
export const HISTORY_LIMIT = 10;

/**
 * One line describing where a run has got to.
 *
 * `WORKFLOW_STATUS_LABELS` is the SDK's neutral map — a `Record` keyed by the
 * status union rather than a switch, so a status added upstream is a compile
 * error in one place every page inherits, and spreading a complete record cannot
 * drop a key. Two of these keys are really this desk's: a page knows what its
 * workflow does and the SDK does not.
 */
const STATUS_LINE = {
  ...WORKFLOW_STATUS_LABELS,
  running: "Transcribing…",
  completed: "Transcript ready",
};

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
export function History({
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
export function RunPanel({ run, onClear }: { run: WorkflowRun<Transcript>; onClear?: () => void }) {
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
          above, and the reason both exist: the status is `running` for the whole
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
            {run.output.segments} {plural(run.output.segments, "segment")} ·{" "}
            {formatDuration(run.output.durationMs)} of audio · took{" "}
            {formatDuration(run.output.elapsedMs)} · {run.output.words} words
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
        {countWords(transcript)} words so far · through {formatDuration(covered)}
      </p>
      <pre className="whitespace-pre-wrap text-sm leading-relaxed opacity-80">{transcript}</pre>
    </div>
  );
}
