// Copyright 2026 the AAI authors. MIT license.
/**
 * What this desk does with a finished deep-research pass — the one part of the
 * run that is the desk's own.
 *
 * The pass itself is `deepResearchWorkflow()` (`@alexkroman1/aai/experimental`),
 * declared in `shared.ts`. It used to be written out here, and it is the SDK's
 * now because a second agent copied it nearly verbatim and differed in exactly
 * three places — the prompts, the search builtin, and what happens to the
 * report. Those are that factory's options, and this template is their worked
 * example:
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
 * The step names above are the ones this file journaled under before the move,
 * so a run in flight across the upgrade resumes rather than re-researching.
 *
 * ## What the SDK owns, and what that bought
 *
 * The budget is MECHANISM, not prompt: each researcher is a `subagent()` whose
 * `maxSteps` is `budget.researcherSteps`, so past the cap it answers with its
 * tools withheld instead of stopping mid-chain. The whole loop is ONE step
 * result — what the researcher concluded — because replaying a negotiation with
 * a search engine turn by turn would pin a run to decisions that were only ever
 * provisional. Every stage narrates through `stepReport`, which is what
 * `research_progress` reads back down the phone.
 *
 * ## What `deliver` is allowed to do
 *
 * It runs in the BODY, with the run's `ctx`, after `writeReport`. So it obeys the
 * body's rules — anything non-deterministic inside a `ctx.step` of its own
 * naming — and it may SUSPEND: the review wait below is a `ctx.sleep`, and on
 * resume every research step above it answers from the journal. Whatever it
 * returns is the run's output: what `research_status` reads back and what the
 * `notify` announcement is built from.
 */

import type { SleepOptions, WorkflowContext } from "@alexkroman1/aai";
import type { DeepResearchResult } from "@alexkroman1/aai/experimental";
import { file } from "./filing.ts";
import { REVIEW_DELAY_MS, REVIEW_SLEEP_ID } from "./review.ts";

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
 * The wait is NAMED, and the name is the whole reason `file_it_now` cannot end
 * a suspension it was not asked about; `review.ts` carries the argument.
 */
export async function deliverResearch(
  result: DeepResearchResult,
  input: { topic: string; requestedBy: string },
  ctx: WorkflowContext,
): Promise<Findings> {
  await ctx.sleep("reviewWindow", REVIEW_DELAY_MS, {
    correlationId: REVIEW_SLEEP_ID,
  } satisfies SleepOptions);

  return {
    topic: result.topic,
    summary: result.summary,
    report: result.report,
    sources: result.sources.length,
    angles: result.notes.map((note) => note.angle),
    // The step's ARGUMENT is serialized, so what crosses is data rather than
    // the notes themselves — which is also why the report does not travel: a
    // filed message says what was found and where to read it, not the whole of
    // it. See `filing.ts`.
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
