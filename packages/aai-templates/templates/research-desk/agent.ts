// Copyright 2026 the AAI authors. MIT license.
/**
 * A voice agent that hands work off to a durable workflow — the worked example
 * for `agent({ workflows })`.
 *
 * This is the HANDOFF shape: a caller is on the line, so a tool starts a run and
 * answers the turn. When the workflow IS the product — a form rather than a
 * call — the agent is declared with `workflowApp()` instead and has no session
 * at all; `link-digest` is that one, at its smallest.
 *
 * The whole point is the thing a voice agent cannot otherwise do: **answer the
 * caller now, finish the work later.** Research takes minutes; the caller is on
 * the line. So `request_research` starts a run and returns in the same turn, the
 * run outlives the call, and a LATER call reads the result back.
 *
 * ## And it SAYS SO when the work lands
 *
 * `start(…, { notify })` is what closes the loop that used to be open: the agent
 * promised an update, the run finished, and nothing made it speak — the caller
 * had to think to ask again. With it, a finished run takes an unprompted,
 * interruptible turn on this session, built from the run's own output.
 *
 * Two limits worth knowing, both by construction. It reaches the session that
 * STARTED the run, only while that session is alive — an announcement into a
 * call that has ended is nobody's — and it needs a transport that can take an
 * unprompted turn, which pipeline mode can and S2S cannot. That is why `key`
 * stays: the next call still finds the run.
 *
 * ## The correlation key is what makes the second call possible
 *
 * `start()` hands back a `runId`, and the obvious place for a tool to keep it is
 * `ctx.state` — which is swept shortly after the caller hangs up. So the run
 * outlives the session and the only handle to it does not. Passing
 * `{ key: ctx.sessionId }` puts the run in an index the agent can search later
 * with `find`, without maintaining its own table.
 *
 * `ctx.sessionId` keys THIS call. A real desk would key on something that
 * survives across calls — the caller's phone number, an account id — so
 * "what happened to my research?" works from a different session. The mechanism
 * is identical; only the key changes.
 *
 * ## What is NOT here
 *
 * No `ctx.step`, no `ctx.waitFor`. Steps are `"use step"` functions in
 * `workflows/research.ts` and waitpoints are the Workflow DevKit's own
 * `defineHook()`. The SDK's job is declaring the workflow and starting runs; the
 * durable execution belongs to `workflow`.
 *
 * ## The research is real, and it really searches the web
 *
 * `workflows/research.ts` is a deep-research pass, not three model calls in a
 * row: it writes a brief, plans the angles worth pursuing, gives each angle its
 * own researcher step that SEARCHES and READS until its budget runs out, asks
 * what is still unanswered, and only then writes the report. The search and the
 * page reads go through `webSearch`/`visitWebpage` from `@alexkroman1/aai/tools`
 * — the same implementations behind the model-facing builtins, which is the
 * point: a step is not a lesser environment than a tool body.
 *
 * The model calls go through the same `ASSEMBLYAI_API_KEY` this agent's voice
 * pipeline uses. A step is handed no `ToolContext`, so it reads that key with
 * `requireStepEnv` rather than `ctx.env`; see that file's module doc for the one
 * thing that changes under `aai dev` (the key has to be in `.env`, not just your
 * shell).
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
import { researchFlow } from "./workflows/research.ts";

/**
 * The declaration: schema, description, and the directive body.
 *
 * Exported so a client page could derive its output type with `WorkflowOutputOf`
 * — and because `ctx.workflows.start(research, …)` below takes the definition
 * itself rather than its name, which is what types the input and makes a typo a
 * compile error instead of a rejected promise the model reads as a tool failure.
 */
export const research = workflow({
  description:
    "Research a topic properly — brief, angles, web search per angle, a gap pass, then a written report",
  input: z.object({
    topic: z.string().min(3).describe("What to research"),
    requestedBy: z.string().describe("Who asked — used when filing the result"),
  }),
  run: researchFlow,
});

/** How many past runs the status tool will look at. Newest first. */
const RECENT_RUNS = 3;

/**
 * One line a voice agent can read aloud about a run.
 *
 * `WorkflowOutputOf` is what names the output type — the same helper a page uses
 * to type `run.output`, and the reason this signature does not have to reach
 * past the declaration into the body's own return type.
 */
function describeRun(run: WorkflowRunSnapshot<WorkflowOutputOf<typeof research>>): string {
  // `isTerminal` narrows to the three finished statuses, which is what makes
  // `run.output` and `run.error` reachable without a cast.
  if (!isTerminal(run)) return "Still working on it.";
  switch (run.status) {
    case "completed":
      return `Done: ${run.output.summary} (${run.output.sources} sources)`;
    case "failed":
      return `That one failed: ${run.error}`;
    default:
      return "That one was cancelled.";
  }
}

export default agent({
  name: "Research Desk",
  greeting: "Research desk. What would you like me to look into?",
  systemPrompt: [
    "You take research requests over the phone and read back results.",
    "When someone asks you to research something, call request_research and tell them",
    "you have started it — do NOT wait for it or promise a time. You WILL be told",
    "when it lands, so it is safe to say you will let them know.",
    "When someone asks about earlier work, call research_status.",
    "If they ask what is happening right now, call research_progress.",
    "If they say they need it immediately, call file_it_now.",
    "Keep replies to one or two sentences; this is a voice call.",
  ].join(" "),

  workflows: { research },

  tools: {
    request_research: tool({
      description:
        "Start researching a topic. Returns immediately; the work continues after the call.",
      inputSchema: z.object({ topic: z.string().min(3) }),
      execute: async ({ topic }, ctx) => {
        // The definition, not the string "research": that types `topic` against
        // the workflow's own schema. `key` is what `research_status` searches on.
        const runId = await ctx.workflows.start(
          research,
          { topic, requestedBy: ctx.sessionId },
          {
            key: ctx.sessionId,
            // What makes "I'll let you know" true. The run finishes minutes
            // later, with no turn to land in — so the SDK gives the agent one:
            // when it settles, this session takes an unprompted turn built from
            // the run's own output, and the caller hears the answer without
            // having to think to ask again.
            //
            // The instruction is a sentence for the MODEL, not a line to read:
            // it is the only thing that knows what this caller has already been
            // told. Omit it (`notify: true`) for the SDK's default.
            //
            // `key` is still the durable handle: an announcement only reaches
            // THIS call, and a run outlives it.
            notify: "Tell them the research came back, then read the summary in one sentence.",
          },
        );
        return { started: true, runId, topic };
      },
    }),

    research_status: tool({
      description: "Report on research started earlier in this call.",
      execute: async (_args, ctx) => {
        const runs = await ctx.workflows.find(research, ctx.sessionId, { limit: RECENT_RUNS });
        if (runs.length === 0) return { runs: [] as string[], note: "Nothing started yet." };
        return { runs: runs.map((run) => `${run.workflow}: ${describeRun(run)}`) };
      },
    }),

    research_progress: tool({
      description: "Say what the research is doing right now, for a run that has not finished yet.",
      execute: async (_args, ctx) => {
        const [latest] = await ctx.workflows.find(research, ctx.sessionId, { limit: 1 });
        if (!latest) return { note: "Nothing started yet." };
        // `research_status` reports the run's STATUS; this reports what the run
        // has WRITTEN (`getWritable()` in `workflows/research.ts`). Between "still
        // working on it" and a finished summary there is otherwise nothing to say.
        //
        // `streamTail` FIRST, and not as an optimization: a progress channel is
        // never closed — no step knows it is the last one — so reading a stream
        // with nothing in it waits forever rather than ending. `-1` is "nothing
        // written yet", and it is the only safe way to learn that.
        if ((await ctx.workflows.streamTail(latest.runId)) < 0) {
          return { note: "Started, nothing to report yet." };
        }
        // A negative `startIndex` reads from the END, which is what a voice reply
        // wants — the last line, not a recital of the whole log.
        const stream = await ctx.workflows.stream(latest.runId, { startIndex: -1 });
        for await (const line of stream) return { progress: String(line) };
        return { note: "Started, nothing to report yet." };
      },
    }),

    file_it_now: tool({
      description:
        "Skip the review wait on the research and file it immediately. Use when the caller says they need it now.",
      execute: async (_args, ctx) => {
        const [latest] = await ctx.workflows.find(research, ctx.sessionId, { limit: 1 });
        if (!latest) return { note: "Nothing started yet." };
        // The counterpart of the `sleep` in `workflows/research.ts`. Without it
        // the only handle on a sleeping run is `cancel`, so "send it now" and
        // "throw it away" would be the same button — and the wait a real desk
        // uses is hours, not the thirty seconds this template ships.
        //
        // `0` is an honest answer, not a failure: the run had already moved past
        // its wait, or finished.
        const woken = await ctx.workflows.wakeUp(latest.runId);
        return woken > 0
          ? { filed: true, note: "Filing it now." }
          : { filed: false, note: "That one was not waiting — it has already moved on." };
      },
    }),
  },
});
