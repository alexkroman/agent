// Copyright 2026 the AAI authors. MIT license.
/**
 * The research workflow — the declaration, and the one part of the run that is
 * the desk's own.
 *
 * `deepResearchWorkflow()` (`@alexkroman1/aai/experimental`) is the whole pass:
 *
 * ```text
 *   writeBrief      1 step    →  the request as something a researcher is held to
 *   planAngles      1 step    →  the angles worth pursuing (the fan-out's width)
 *   investigate     N steps   →  one SUBAGENT each: search, read, cite, report
 *   findGaps        1 step    →  the supervisor's second look
 *   investigateGap  M steps   →  the second wave, when there is one
 *   writeReport     1 step    →  the report, then the sentence for the phone
 *   ─── deliverResearch (this file) ─────────────────────────────────────────
 *   sleep + file    1 step    →  the review wait, then filing (`filing.ts`)
 * ```
 *
 * What is written here is only what this desk decides: who the brief and the
 * summary are for (`prompts.ts`), what happens to the report once it is
 * written ({@link deliverResearch}), and what the desk SAYS about a run
 * ({@link describeRun}). The researcher keeps the keyless
 * `web_search`/`visit_webpage` default and the default budget.
 *
 * The default export is the declaration: `workflows/research.ts` registers the
 * workflow as `research`, the name the run builtins and the run API know it by.
 */

import type { WorkflowContext } from "@alexkroman1/aai";
import { type DeepResearchResult, deepResearchWorkflow } from "@alexkroman1/aai/experimental";
import { plural } from "@alexkroman1/aai/utils";
import { isTerminal, type WorkflowRunSnapshot } from "@alexkroman1/aai/workflow-api";
import { z } from "zod";
import { file } from "./filing.ts";
import { BRIEF_SUMMARY_SYSTEM, BRIEF_SYSTEM } from "./prompts.ts";

/**
 * How long the desk sits on a finished report before filing it.
 *
 * Short enough to watch in `aai dev`. Nothing about the body changes if it is
 * `"6 hours"` — the run is SUSPENDED rather than blocked, so the sandbox is free
 * to exit and the run resumes when it comes due. `file_it_now` ends the wait
 * early by its label, `reviewWindow`.
 */
export const REVIEW_DELAY_MS = 30_000;

const input = z.object({
  topic: z.string().min(3).describe("What to research"),
  requestedBy: z.string().describe("Who asked — used when filing the result"),
});

/** What one research pass answers with — the run's output. */
export type Findings = {
  topic: string;
  /** Two sentences, for an agent to read down a phone. */
  summary: string;
  /** The written report — markdown, cited. What a page renders. */
  report: string;
  /** How many distinct sources were used, which is what the voice agent quotes. */
  sources: number;
  angles: string[];
  /** When the report was filed, as the filing step recorded it. */
  filedAt: string;
};

/**
 * The review wait, then filing — `deepResearchWorkflow`'s `deliver`.
 *
 * It runs in the BODY, with the run's `ctx`, after `writeReport`, so it obeys
 * the body's rules and it may SUSPEND: on resume every research step above it
 * answers from the journal. What it returns is the run's output — what the
 * status line reads back and what the `notify` announcement is built from.
 */
export async function deliverResearch(
  result: DeepResearchResult,
  input: { topic: string; requestedBy: string },
  ctx: WorkflowContext,
): Promise<Findings> {
  // The label is also what `file_it_now` wakes, so "send it now" ends THIS
  // wait and not an approval window a later body might open.
  await ctx.sleep("reviewWindow", REVIEW_DELAY_MS);

  return {
    topic: result.topic,
    summary: result.summary,
    report: result.report,
    sources: result.sources.length,
    angles: result.notes.map((note) => note.angle),
    // A step's ARGUMENT is serialized, so what crosses is data rather than the
    // notes themselves — and the report does not travel: a filed message says
    // what was found and where to read it. See `filing.ts`.
    filedAt: await ctx.step("file", () =>
      file({
        topic: result.topic,
        requestedBy: input.requestedBy,
        summary: result.summary,
        angles: result.notes.map(({ angle, sources }) => ({ angle, sources })),
      }),
    ),
  };
}

/** When the caller asked for it, in words a phone can carry. */
function askedAt(createdAt: number, now: number): string {
  const minutes = Math.round((now - createdAt) / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} ${plural(minutes, "minute")} ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} ${plural(hours, "hour")} ago`;
}

/**
 * One line a voice agent reads aloud about a run — what `workflow_status`
 * says per run. It leads with WHEN the caller asked, because that is the only
 * thing distinguishing two of their requests. Pure in `now`; the declaration
 * below reads the clock when a builtin asks.
 */
function describeRunAt(run: WorkflowRunSnapshot<Findings>, now: number): string {
  const when = askedAt(run.createdAt, now);
  if (!isTerminal(run)) return `${when}: still working on it.`;
  switch (run.status) {
    case "completed":
      return `${when}: done — ${run.output.summary} (${run.output.sources} ${plural(run.output.sources, "source")})`;
    case "failed":
      return `${when}: that one failed: ${run.error}`;
    default:
      return `${when}: that one was cancelled.`;
  }
}

/**
 * The declaration: the pass, plus the two spoken lines the run builtins read
 * off it — `describeRun` and `cancelNote` are `deepResearchWorkflow`'s own
 * options, passed through to the def.
 */
const research = deepResearchWorkflow({
  description:
    "Research a topic properly — brief, angles, web search per angle, a gap pass, then a written report",
  input,
  prompts: { brief: BRIEF_SYSTEM, summary: BRIEF_SUMMARY_SYSTEM },
  deliver: deliverResearch,
  // Runs on the HOST when a builtin reads the run back — never inside the
  // replayed body — so the clock is read here, where guard rule 30 exempts it.
  describeRun: (run) => describeRunAt(run, Date.now()),
  cancelNote: "Dropped that research. Nothing was filed.",
});

export default research;
