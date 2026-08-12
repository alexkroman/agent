// Copyright 2026 the AAI authors. MIT license.
/**
 * A voice agent that hands a recording to a durable workflow which FANS OUT over
 * it — the worked example for a workflow whose step count is not fixed.
 *
 * ## What this shows that `research-desk` does not
 *
 * `research-desk` is the template to read first: it owns the handoff — start a
 * run inside a tool, answer the caller in the same turn, correlate the run with
 * `{ key }` so a later turn can find it. All of that is the same here and is not
 * restated.
 *
 * What is new is the SHAPE OF THE BODY, and one tool:
 *
 * 1. **A fan-out whose width is discovered, not declared.** `research-desk`'s
 *    body is a straight line of two steps known at authoring time. This one runs
 *    one step per chunk of a recording, and how many chunks that is comes from
 *    another step's result. `workflows/transcribe.ts` is where that lives, and
 *    its module doc carries the rule that makes it work: the Workflow DevKit
 *    correlates a journal entry to a step call by the ORDER the call was issued
 *    in, so `Promise.all` over a `map` is safe and a work-stealing pool is not.
 *    Nothing else in this repo says that, and it is the one piece of the old
 *    hand-rolled engine's API that did not survive the port — there is no
 *    caller-supplied step key any more.
 * 2. **Partial progress is the point of the durability.** A run that dies on
 *    chunk 27 resumes having replayed 1–26 from the journal for free. That is
 *    the property a fan-out buys and a two-step body cannot demonstrate.
 * 3. **`cancel_transcript`.** `ctx.workflows.cancel` is exercised by no other
 *    template. A long fan-out is the case that motivates it: a caller who names
 *    the wrong recording should be able to stop forty pending steps, and a
 *    cancelled run is terminal with its journal intact rather than deleted.
 *
 * Requires storage (`aai storage enable`, or `DATABASE_URL` under `aai dev`) —
 * runs and the key index both live there.
 */

import {
  agent,
  isTerminal,
  tool,
  type WorkflowOutputOf,
  type WorkflowRunSnapshot,
  workflow,
} from "@alexkroman1/aai";
import { z } from "zod";
import { transcribeFlow } from "./workflows/transcribe.ts";

/**
 * The declaration: schema, description, and the directive body.
 *
 * Exported so `WorkflowOutputOf<typeof transcribe>` names the output type in one
 * place — including from a client page, where `import type` is erased and so
 * bundles nothing server-side.
 */
export const transcribe = workflow({
  description: "Transcribe a recording chunk by chunk and file the transcript",
  input: z.object({
    recordingId: z.string().min(1).describe("Which recording to transcribe"),
    requestedBy: z.string().describe("Who asked — used when filing the result"),
  }),
  run: transcribeFlow,
});

/** What a completed run reports, without restating the body's return shape. */
type Transcript = WorkflowOutputOf<typeof transcribe>;

/** How many past runs the status tool will look at. Newest first. */
const RECENT_RUNS = 3;

/** Words of transcript the desk will read aloud before summarizing instead. */
const SPOKEN_WORDS = 40;

/** One line a voice agent can read aloud about a run. */
function describeRun(run: WorkflowRunSnapshot<Transcript>): string {
  // `isTerminal` narrows to the three finished statuses, which is what makes
  // `run.output` and `run.error` reachable without a cast.
  if (!isTerminal(run)) return "Still working on that one.";
  switch (run.status) {
    case "completed":
      return `Done — ${run.output.chunks} chunks, ${run.output.words} words.`;
    case "failed":
      return `That one failed: ${run.error}`;
    default:
      return "That one was cancelled.";
  }
}

export default agent({
  name: "Transcription Desk",
  greeting: "Transcription desk. Which recording should I run?",
  systemPrompt: [
    "You take transcription requests over the phone and read results back.",
    "When someone names a recording, call request_transcript and tell them you have",
    "started it — do NOT wait for it or promise a time.",
    "When someone asks how it went, call transcript_status.",
    "When someone wants to stop one, call cancel_transcript.",
    "Keep replies to one or two sentences; this is a voice call.",
  ].join(" "),

  workflows: { transcribe },

  tools: {
    request_transcript: tool({
      description:
        "Start transcribing a recording. Returns immediately; the work continues after the call.",
      inputSchema: z.object({ recordingId: z.string().min(1) }),
      execute: async ({ recordingId }, ctx) => {
        // The definition, not the string "transcribe": that types `recordingId`
        // against the workflow's own schema. `key` is what the other two tools
        // search on.
        const runId = await ctx.workflows.start(
          transcribe,
          { recordingId, requestedBy: ctx.sessionId },
          { key: ctx.sessionId },
        );
        return { started: true, runId, recordingId };
      },
    }),

    transcript_status: tool({
      description: "Report on transcription started earlier in this call.",
      execute: async (_args, ctx) => {
        const runs = await ctx.workflows.find(transcribe, ctx.sessionId, { limit: RECENT_RUNS });
        if (runs.length === 0) return { runs: [] as string[], note: "Nothing started yet." };
        return {
          runs: runs.map((run) => `${run.runId}: ${describeRun(run)}`),
          // The transcript itself only rides along when it is short enough to
          // say out loud; a forty-minute recording read back over the phone is
          // not an answer, and the model would try.
          ...transcriptIfShort(runs),
        };
      },
    }),

    cancel_transcript: tool({
      description: "Stop the transcription currently running for this caller.",
      execute: async (_args, ctx) => {
        const runs = await ctx.workflows.find(transcribe, ctx.sessionId, { limit: RECENT_RUNS });
        const live = runs.find((run) => !isTerminal(run));
        if (!live) return { cancelled: false, note: "Nothing is running." };
        // `cancel` resolves false when the run finished between the `find` above
        // and this call — a race a long fan-out really does lose sometimes, so
        // it is reported rather than asserted away.
        const cancelled = await ctx.workflows.cancel(live.runId);
        return cancelled
          ? { cancelled: true, runId: live.runId }
          : { cancelled: false, note: "That one had already finished." };
      },
    }),
  },
});

/** The newest completed transcript, when it is short enough to read aloud. */
function transcriptIfShort(runs: WorkflowRunSnapshot<Transcript>[]): { transcript?: string } {
  const done = runs.find((run) => run.status === "completed");
  // Re-tested rather than trusted: `find`'s predicate does not narrow the
  // element type, so this is what makes `done.output` reachable without a cast.
  if (done?.status !== "completed") return {};
  return done.output.words <= SPOKEN_WORDS ? { transcript: done.output.transcript } : {};
}
