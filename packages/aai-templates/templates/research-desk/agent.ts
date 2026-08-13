// Copyright 2026 the AAI authors. MIT license.
/**
 * A voice agent that hands work off to a durable workflow — the worked example
 * for `agent({ workflows })`.
 *
 * The whole point is the thing a voice agent cannot otherwise do: **answer the
 * caller now, finish the work later.** Research takes minutes; the caller is on
 * the line. So `request_research` starts a run and returns in the same turn, the
 * run outlives the call, and a LATER call reads the result back.
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
  description: "Research a topic, sit on it briefly, then file the findings",
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
    "you have started it — do NOT wait for it or promise a time.",
    "When someone asks about earlier work, call research_status.",
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
          { key: ctx.sessionId },
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
  },
});
