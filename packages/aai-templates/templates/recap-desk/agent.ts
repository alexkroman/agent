// Copyright 2026 the AAI authors. MIT license.
/**
 * A voice agent over a durable, compensating workflow — the Temporal patterns
 * ported to a phone call.
 *
 * The desk transcribes a recording and writes it up. That takes minutes, and
 * the caller is on the line for seconds, so the shape is `research-desk`'s: a
 * tool starts a run and answers the turn, the run outlives the call, and the
 * finished run takes an unprompted turn to read the result back.
 *
 * What this template is FOR is the other half — the four things a caller can do
 * to a run in flight, which are the Temporal Workflow-API samples with a
 * microphone in front of them:
 *
 * | Temporal sample | Ported here as |
 * | --- | --- |
 * | `signals-queries` — Query | `recap_status`, reading a run snapshot aloud |
 * | `signals-queries` — Workflow Cancellation | `cancel_recap` |
 * | workflow-id reuse / `mutex` — one run per entity | the live-run check in `request_recap` |
 * | `timer-progress` — progress reporting | `recap_progress`, over the run's own stream |
 *
 * The durable half — the saga, the poll loop, the timer race — is in
 * `workflows/recap.ts`, which carries its own table.
 *
 * ## Why a voice call is the honest front door for these
 *
 * Every one of these patterns exists because SOMEBODY IS WAITING and the work
 * is not done. A phone call makes that concrete in a way a form does not: the
 * caller cannot see a spinner, cannot refresh, and will ask "is it done yet?"
 * out loud — which is a Query — and "forget it, cancel that" — which is a
 * Cancellation. The Temporal samples model an operator with a CLI. This models
 * the same operator with a phone, and the mechanism underneath is identical.
 *
 * ## The gate is why the SDK grew `ctx.workflows.signal()`
 *
 * `expense` is the most voice-native sample Temporal ships — a run that waits
 * for a person to say yes — and it was unportable here until this template
 * asked for it. The DevKit's only reachable waitpoint was `createWebhook()`,
 * whose URL is minted for a THIRD PARTY with a callback to make; the caller is
 * not that, they are on the line right now, and the thing that should resume
 * the run is a tool. `signal(token, payload)` is that, and `keep_transcript`
 * below is four lines because of it.
 *
 * ## One thing still does NOT port, and it matters
 *
 * **Cancellation is not cooperative.** Temporal delivers cancellation INTO the
 * workflow, so the saga's `catch` runs and the compensations unwind.
 * `ctx.workflows.cancel` marks the run cancelled and stops replaying it — the
 * body's `catch` never runs, so a cancelled recap leaves its transcript on the
 * account. `cancel_recap` says so rather than pretending otherwise, and the
 * compensation stack covers the case it really does cover: FAILURE.
 *
 * The gate is what a cooperative stop would be built from — a hook the body
 * races alongside its work, signalled instead of cancelling — and this template
 * deliberately stops at one hook. Racing a stop into every wait is a second
 * lesson, and it would cost this one its shape.
 *
 * ## What it needs
 *
 * `ASSEMBLYAI_API_KEY` in the agent env — `.env` under `aai dev`, `aai secret
 * put ASSEMBLYAI_API_KEY` once deployed. The same key the voice pipeline uses;
 * the run really submits the recording, really polls it, and really deletes it
 * when it has to.
 *
 * Requires storage (`aai storage enable`, or `DATABASE_URL` under `aai dev`) —
 * runs and the correlation-key index both live there.
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
import { recapFlow } from "./workflows/recap.ts";
import { retentionToken } from "./workflows/tokens.ts";

/**
 * What the desk works on when the caller does not name something else.
 *
 * A phone caller cannot read a URL aloud, which is the practical reason this
 * exists — and it is a real, public, documented sample file, so the template
 * transcribes something on the first call instead of asking for a URL it cannot
 * be given. A real desk replaces this with a lookup against its own recording
 * store: the caller says "yesterday's board meeting" and the tool resolves the
 * name.
 */
const SAMPLE_RECORDING = "https://assembly.ai/wildfires.mp3";

/** How many past runs the status tool will look at. Newest first. */
const RECENT_RUNS = 3;

/**
 * The declaration: schema, description, and the directive body.
 *
 * Exported because `ctx.workflows.start(recap, …)` below takes the definition
 * rather than the string `"recap"`, which is what types the input against this
 * schema and makes a typo a compile error instead of a rejected promise the
 * model reads as a tool failure.
 */
export const recap = workflow({
  description:
    "Transcribe a recording with the batch API, poll it to completion, and write up what was said",
  input: z.object({
    url: z.url().describe("The recording to write up"),
    requestedBy: z.string().describe("Who asked — carried through to the finished recap"),
  }),
  run: recapFlow,
});

/**
 * One line a voice agent can read aloud about a run.
 *
 * This is the QUERY, and `isTerminal` is what makes it typed: it narrows to the
 * three finished statuses, which is what puts `run.output` and `run.error`
 * within reach without a cast. `WorkflowOutputOf` names the output type from the
 * declaration, so this signature never reaches past it into the body.
 */
function describeRun(run: WorkflowRunSnapshot<WorkflowOutputOf<typeof recap>>): string {
  if (!isTerminal(run)) return "Still working on that one.";
  switch (run.status) {
    case "completed": {
      // The gate's outcome is part of the answer: a caller who never got round
      // to answering should hear that the transcript is gone, not just the recap.
      const fate = run.output.kept ? "transcript kept" : "transcript deleted";
      return `Done: ${run.output.spoken} (${fate})`;
    }
    case "failed":
      // The run compensated before it failed — see `workflows/recap.ts` — so
      // there is nothing left to clean up and nothing for the caller to do
      // beyond asking again.
      return `That one failed and was rolled back: ${run.error}`;
    default:
      return "That one was cancelled.";
  }
}

export default agent({
  name: "Recap Desk",
  greeting: "Recap desk. Want me to write up a recording?",
  systemPrompt: [
    "You take recordings over the phone, hand them to a transcription run, and read back recaps.",
    "When someone asks you to write up a recording, call request_recap and tell them you have",
    "started it — do NOT wait for it or promise a time. You WILL be told when it lands, so it is",
    "safe to say you will let them know.",
    "When the run asks whether to keep the transcript, relay the question and call",
    "keep_transcript with their answer.",
    "If they ask how it is going, call recap_progress. If they ask about earlier work, call",
    "recap_status. If they say to stop or forget it, call cancel_recap.",
    "Keep replies to one or two sentences; this is a voice call.",
  ].join(" "),

  workflows: { recap },

  // Checked at deploy time: the steps read this key with `requireStepEnv`, and a
  // missing one should fail the deploy rather than the first run.
  requiredEnv: ["ASSEMBLYAI_API_KEY"],

  tools: {
    request_recap: tool({
      description:
        "Start writing up a recording. Returns immediately; the work continues after the call.",
      inputSchema: z.object({
        url: z.url().optional().describe("The recording, if the caller named one"),
      }),
      execute: async ({ url }, ctx) => {
        // Temporal's workflow-id reuse policy, spelled with what this SDK has:
        // the desk allows ONE live recap per caller, so a caller who asks twice
        // is told about the run they already have instead of paying for a second
        // transcription of the same audio. `find` searches the correlation-key
        // index — the same key `start` writes below.
        const [live] = await ctx.workflows.find(recap, ctx.sessionId, { limit: 1 });
        if (live && !isTerminal(live)) {
          return { started: false, runId: live.runId, note: "One is already running for you." };
        }

        const runId = await ctx.workflows.start(
          recap,
          { url: url ?? SAMPLE_RECORDING, requestedBy: ctx.sessionId },
          {
            // The durable handle. A `runId` kept in `ctx.state` would be swept
            // shortly after the caller hangs up, while the run outlives the
            // call — so the key is what a later turn (or a later call) finds it
            // by. `ctx.sessionId` keys THIS call; a real desk keys on the
            // caller's number, and nothing else changes.
            key: ctx.sessionId,
            // What makes "I'll let you know" true: when the run settles, this
            // session takes an unprompted, interruptible turn built from the
            // run's own output. The instruction is a sentence for the MODEL —
            // it is the only thing that knows what this caller has been told.
            notify:
              "Tell them the recap is ready, read the one-sentence version, then ask whether " +
              "to keep the transcript on file or delete it.",
          },
        );
        return { started: true, runId };
      },
    }),

    recap_status: tool({
      description: "Report on recaps started earlier in this call.",
      execute: async (_args, ctx) => {
        const runs = await ctx.workflows.find(recap, ctx.sessionId, { limit: RECENT_RUNS });
        if (runs.length === 0) return { runs: [] as string[], note: "Nothing started yet." };
        return { runs: runs.map(describeRun) };
      },
    }),

    recap_progress: tool({
      description: "Say what the transcription is doing right now, for a run still in flight.",
      execute: async (_args, ctx) => {
        const [latest] = await ctx.workflows.find(recap, ctx.sessionId, { limit: 1 });
        if (!latest) return { note: "Nothing started yet." };
        // `recap_status` reports the run's STATUS; this reports what the run has
        // WRITTEN. Between "still working on it" and a finished recap there is
        // otherwise nothing to say — and this run has real news in between,
        // since every poll narrates.
        //
        // `streamTail` FIRST, and not as an optimization: a progress channel is
        // never closed — no step knows it is the last one — so reading a stream
        // with nothing in it waits forever rather than ending. `-1` is "nothing
        // written yet", and it is the only safe way to learn that.
        if ((await ctx.workflows.streamTail(latest.runId)) < 0) {
          return { note: "Submitted, nothing to report yet." };
        }
        // A negative `startIndex` reads from the END, which is what a voice
        // reply wants — the last line, not a recital of the whole log.
        const stream = await ctx.workflows.stream(latest.runId, { startIndex: -1 });
        for await (const line of stream) return { progress: String(line) };
        return { note: "Submitted, nothing to report yet." };
      },
    }),

    keep_transcript: tool({
      description:
        "Answer the desk's question about the transcript. Use when the caller says to keep it, save it, or delete it.",
      inputSchema: z.object({
        keep: z.boolean().describe("True to keep the transcript on file, false to delete it"),
      }),
      execute: async ({ keep }, ctx) => {
        // The SIGNAL, and the whole reason this template exists in the shape it
        // does. The run is parked on a hook whose token both sides derive from
        // the session — see `workflows/tokens.ts` — so the tool needs no runId
        // and no bookkeeping of its own.
        const delivered = await ctx.workflows.signal(retentionToken(ctx.sessionId), { keep });
        // `false` is the ORDINARY answer, not a failure: the window closed, or
        // the caller answered a question nobody asked. Say which.
        if (!delivered) {
          return {
            answered: false,
            note: "Nothing is waiting on that — it has already been settled.",
          };
        }
        return {
          answered: true,
          keep,
          note: keep ? "Keeping the transcript on file." : "Deleting the transcript.",
        };
      },
    }),

    cancel_recap: tool({
      description: "Stop the recap that is running. Use when the caller says to forget it.",
      execute: async (_args, ctx) => {
        const [latest] = await ctx.workflows.find(recap, ctx.sessionId, { limit: 1 });
        if (!latest) return { cancelled: false, note: "Nothing started yet." };
        const cancelled = await ctx.workflows.cancel(latest.runId);
        // `false` is an ANSWER, not a failure: the run was already terminal, so
        // there was nothing to stop. Worth distinguishing out loud — "already
        // done" and "stopped" are different things to a caller.
        return cancelled
          ? {
              cancelled: true,
              // Said plainly because it is true: a cancelled run does not run
              // its compensations (see this file's module doc), so the
              // transcript it had already created stays on the account.
              note: "Stopped it. The partial transcript is left behind — cancelling does not roll back.",
            }
          : { cancelled: false, note: "That one had already finished." };
      },
    }),
  },
});
