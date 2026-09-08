// Copyright 2026 the AAI authors. MIT license.
/**
 * The durable half of the research desk: a real deep-research pass.
 *
 * Read `transcription-workflow/workflows/transcribe.ts` for the rules every
 * directive body obeys — replayed from the top, so no live handles and no
 * undurable decisions; step arguments and results are serialized, so pass an id
 * and not a payload. What this template adds is the OTHER kind of long work:
 * transcription is a fan-out over a known list, and research is a fan-out whose
 * width, depth and second wave are all decided by the model as it goes.
 *
 * ```text
 *   writeBrief      1 step    →  the request as something a researcher is held to
 *   planAngles      1 step    →  the angles worth pursuing (the fan-out's width)
 *   investigate     N steps   →  one SUBAGENT each: search, read, cite, report
 *   findGaps        1 step    →  the supervisor's second look
 *   investigate     M steps   →  the second wave, when there is one
 *   writeReport     1 step    →  the report, then the sentence for the phone
 *   sleep + file    1 step    →  the review wait, then filing (`filing.ts`)
 * ```
 *
 * ## The last step really files it
 *
 * `file` used to return the string `"filed"` and write nothing, which made the
 * review wait a delay before nothing and `file_it_now` a button that skipped
 * one. It posts the findings to a channel now (`filing.ts`), and the channel is
 * optional — a desk with none still researches and still says so.
 *
 * ## Three modules beside this one, and what each is for
 *
 * `notes.ts` is the leaf: the four shapes the stages pass between them and the
 * pure functions that read them, imported by this file and by `filing.ts`.
 * `review.ts` holds the two constants the review wait needs, because
 * `file_it_now` has to name the same one. `prompts.ts` is the prompts. What is
 * left here is the FLOW — which stages exist, in what order, and what each one
 * is allowed to cost.
 *
 * ## A step can do what a TOOL can do, and `stepDelegate` is where that lands
 *
 * `investigate` hands its angle to a SUBAGENT (`stepDelegate`,
 * `@alexkroman1/aai/step`) with `web_search` and `visit_webpage` enabled — the
 * same builtins a voice agent's tools reach, URL screening and size caps
 * included. A step is not a lesser environment than a tool body.
 *
 * **It used to hand-roll the loop, and that is the comparison worth keeping.**
 * This file carried an action schema for the model to pick from, a counter for
 * the budget, a sentence in the prompt telling it to answer once the budget was
 * spent, a branch for the turn where it named an action and filled in none of
 * its fields, and a second model call to compress what it had seen — 82 lines
 * of it, every one re-deriving something `subagent()` already does and the voice
 * pipeline already runs on. A tool call IS an action with a validated schema;
 * `maxSteps` IS the budget; the forced final answer IS the "stop when it is
 * spent" rule, enforced rather than requested; and `expectedOutput` IS the
 * compression, done where the raw material already is instead of in a stage that
 * could disagree with it.
 *
 * The file is 44 code lines lighter for it, which is less than the deletion
 * because what replaced the loop — the researcher, its `cite` tool, and reading
 * the cost off `toolCalls` — is not nothing. What it IS, is this template's own
 * decisions rather than a re-implementation of the framework's.
 *
 * Before any of it, this template's "research" was three model calls asking a
 * model what it already believed, which is the thing deep research exists not to
 * be.
 *
 * The stage shape and its stop rules come from LangChain's
 * `open_deep_research`; `prompts.ts` carries the attribution and what was
 * adapted.
 *
 * ## Every stage REPORTS, and the report goes two places
 *
 * `stepReport()` (`@alexkroman1/aai/step`) writes to the run's own stream — which
 * `research_progress` reads back down the phone and a page renders — and to the
 * server log, with the attempt number appended past the first. A pass that is
 * retrying and one that is working print the same sentences otherwise.
 *
 * ## Where the model calls are, and why the loop is INSIDE one step
 *
 * A researcher's search loop is journaled as ONE step result rather than one per
 * iteration, which is deliberate: the loop is a negotiation with a model and a
 * search engine, and replaying it turn by turn would pin a run to decisions that
 * were only ever provisional. What has to survive a resume is what the
 * researcher CONCLUDED, which is exactly what the step returns.
 *
 * That is also the rule `stepDelegate` has to be used under, and it is the
 * ordinary one: a delegation runs a model and reaches the network, so it belongs
 * inside a `ctx.step` like any other non-deterministic call. Nothing checks it —
 * see `sdk/step-delegate.ts`.
 */

import type {
  SleepOptions,
  StepOptions,
  SubagentDef,
  SubagentToolCall,
  ToolDef,
  WorkflowContext,
} from "@alexkroman1/aai";
import { subagent, tool } from "@alexkroman1/aai";
import { mapConcurrent, stepDelegate, stepReport } from "@alexkroman1/aai/step";
import { stepGenerateJsonOrFail, stepGenerateOrFail } from "@alexkroman1/aai/step-errors";
import { isRecord, plural } from "@alexkroman1/aai/utils";
import { z } from "zod";
import { file } from "./filing.ts";
import {
  type Brief,
  briefText,
  countSources,
  dedupe,
  type Findings,
  type Note,
  noteText,
  type Source,
} from "./notes.ts";
import {
  BRIEF_SUMMARY_SYSTEM,
  BRIEF_SYSTEM,
  GAPS_SYSTEM,
  PLAN_SYSTEM,
  REPORT_SYSTEM,
  RESEARCH_OUTPUT,
  RESEARCH_SYSTEM,
} from "./prompts.ts";
import { REVIEW_DELAY_MS, REVIEW_SLEEP_ID } from "./review.ts";

/**
 * Angles investigated at once. The far side of every one is a rate limit.
 *
 * Inside `DEFAULT_STEP_CONCURRENCY` (`aai-runtime`, 16), so this width is what
 * really runs — see "The WINDOW is not the concurrency" in `mapConcurrent`.
 */
const ANGLE_CONCURRENCY = 2;

/** Most angles a wave may carry, whatever the supervisor asks for. */
const MAX_ANGLES = 4;

/**
 * What a `ctx.step("investigate", …)` costs before the run gives up on it.
 *
 * More attempts than `DEFAULT_STEP_MAX_ATTEMPTS` because an angle is the
 * expensive thing to lose: it is a whole delegated research pass, and the run
 * has already paid for its siblings. Named and shared rather than written at
 * each wave, because the two waves differing by a digit is a difference nobody
 * would ever mean. It was `investigate.maxRetries = 4`.
 */
const ANGLE_STEP = { maxAttempts: 5 } satisfies StepOptions;

/**
 * Tool-calling steps one researcher may take before it must answer.
 *
 * The budget is the mechanism, not the prompt: a model told to stop when it has
 * enough will sometimes not, and a run whose cost is decided by a model is a run
 * nobody can price. Six covers "search, read, search, read" with room to follow
 * one lead.
 *
 * It is `SubagentDef.maxSteps` now rather than a counter this file keeps, which
 * changes one thing beyond the bookkeeping: past the cap the researcher is asked
 * for its answer with its TOOLS WITHHELD, so a capped run still returns findings
 * instead of stopping mid-chain. The loop this replaced had to ask for that in
 * the prompt ("ALWAYS stop when the budget is spent") and had no way to enforce
 * it.
 */
const RESEARCH_BUDGET = 6;

// ---- What each stage's model call has to come back as ------------------------
//
// `stepGenerateJsonOrFail` validates against these, so a reply that missed
// is a plain throw and therefore a retry — where the hand-rolled `askJson<T>()`
// this replaces returned a value the compiler believed and nothing checked. They are
// deliberately LENIENT wherever the old hand-written coercion was: a model that
// put one number in an array of strings should cost that element, not the whole
// pass.

/**
 * A model's array of strings, with everything else dropped.
 *
 * `.catch([])` covers the field being absent or not an array at all, which is
 * the same "take what is usable" rule applied one level up.
 */
const StringList = z
  .array(z.unknown())
  .transform((values) =>
    values.filter((value): value is string => typeof value === "string" && value.trim().length > 0),
  )
  .catch([]);

/** What `writeBrief` asks for. */
const BriefReply = z.object({ brief: z.string().trim().optional(), criteria: StringList });

/** What `planAngles` and `findGaps` ask for. */
const AnglesReply = z.object({ angles: StringList });

/**
 * Research `topic` properly and return something worth reading back.
 *
 * Five to twelve model calls and as many searches, which is the point: it takes
 * long enough that a caller cannot wait for it, and that is what a durable run
 * is for. `agent.ts` starts this with `notify`, so the agent says so when it
 * lands rather than waiting to be asked.
 *
 * The `ctx.sleep` on top is the review wait — the one suspension in the template,
 * and what `file_it_now` skips with `ctx.workflows.wakeUp`.
 */
export async function researchFlow(
  input: { topic: string; requestedBy: string },
  ctx: WorkflowContext,
) {
  const brief = await ctx.step("writeBrief", () => writeBrief(input.topic));
  const angles = await ctx.step("planAngles", () => planAngles(brief));

  // One step per angle, bounded, in an order a replay reproduces exactly —
  // `mapConcurrent` hands out items from a monotonic cursor, so the Nth call
  // ISSUED is item N whatever order they settle in, and the Nth call is
  // `investigate#N`. A failed angle fails the RUN: its finished siblings are
  // already journaled, so the resume replays them for free and re-issues only
  // what is missing, where catching here would file a report with a silent hole
  // in it. `ANGLE_STEP` is the retry policy both waves share.
  const first = await mapConcurrent(angles, ANGLE_CONCURRENCY, (angle) =>
    ctx.step("investigate", () => investigate(brief, angle), ANGLE_STEP),
  );

  // The supervisor's second look. Usually empty — a second wave costs the caller
  // minutes, and the prompt says so.
  const gaps = await ctx.step("findGaps", () => findGaps(brief, first));
  // A DIFFERENT step name from the first wave, though it calls the same
  // function. Two waves under one name would share one occurrence counter, which
  // is replay-safe (the waves are sequential, so the order is fixed) and reads
  // terribly in a run's history: `investigate#7` would be the second wave's
  // first angle with nothing saying so. The name is what an operator reads.
  const second = await mapConcurrent(gaps, ANGLE_CONCURRENCY, (angle) =>
    ctx.step("investigateGap", () => investigate(brief, angle), ANGLE_STEP),
  );

  const notes = [...first, ...second];
  const written = await ctx.step("writeReport", () => writeReport(input.topic, brief, notes));

  // Suspended, not blocked. On resume the body re-runs from the top and every
  // step above returns its journaled result rather than researching again —
  // which is also what `file_it_now` ends early, through `ctx.workflows.wakeUp`.
  //
  // The wait is NAMED, and the name is the whole reason `file_it_now` cannot
  // end a suspension it was not asked about; `review.ts` carries the argument.
  await ctx.sleep("reviewWindow", REVIEW_DELAY_MS, {
    correlationId: REVIEW_SLEEP_ID,
  } satisfies SleepOptions);

  // Whatever this returns is what `ctx.workflows.get(runId)` reports as `output`
  // on a completed run — so it is what the agent reads back, and what the
  // announcement is built from.
  return {
    topic: input.topic,
    summary: written.summary,
    report: written.report,
    sources: countSources(notes),
    angles: notes.map((note) => note.angle),
    // The step's ARGUMENT is serialized, so what crosses is data rather than
    // the `notes` array itself — which is also why the report does not travel:
    // a filed message says what was found and where to read it, not the whole
    // of it. See `filing.ts`.
    filedAt: await ctx.step("file", () =>
      file({
        topic: input.topic,
        requestedBy: input.requestedBy,
        summary: written.summary,
        angles: notes.map(({ angle, sources }) => ({ angle, sources })),
      }),
    ),
  } satisfies Findings & { filedAt: string };
}

/**
 * Turn the phone request into a brief.
 *
 * A step rather than body code for the ordinary reason — it does I/O — and a
 * stage at all because everything downstream measures against it: a request
 * that arrived as four words is otherwise re-interpreted, differently, by every
 * later model call.
 */
export async function writeBrief(topic: string): Promise<Brief> {
  await stepReport(`Working out what "${topic}" is really asking.`);
  const parsed = await stepGenerateJsonOrFail(`Research request, as the caller said it: ${topic}`, {
    system: BRIEF_SYSTEM,
    schema: BriefReply,
  });
  return { brief: parsed.brief || topic, criteria: parsed.criteria.slice(0, MAX_ANGLES) };
}

/**
 * Break the brief into the angles worth pursuing.
 *
 * The fan-out's WIDTH comes from this step's journaled result, which is the
 * ordinary determinism rule: a replay re-derives the same list rather than
 * asking the model again and getting a different one.
 */
export async function planAngles(brief: Brief): Promise<string[]> {
  const parsed = await stepGenerateJsonOrFail(briefText(brief), {
    system: PLAN_SYSTEM,
    schema: AnglesReply,
  });
  const angles = parsed.angles.slice(0, MAX_ANGLES);
  if (angles.length === 0) {
    // Nothing to fan out over is a plan failure, not an empty result: the brief
    // itself is the one angle that is always available.
    await stepReport("No angles came back; researching the brief itself.");
    return [brief.brief];
  }
  await stepReport(`Researching ${angles.length} ${plural(angles.length, "angle")}.`);
  return angles;
}

/**
 * The researcher — one angle, its own tools, its own context window.
 *
 * **This is the whole of what used to be a loop.** The budget, the forced final
 * answer once it is spent, the failure fed back as an observation, and the
 * schema the model picks an action from were four things this template wrote by
 * hand around `stepGenerateJson`; a subagent is all four, and the same four the
 * voice pipeline already ran on. What is left here is the part that is actually
 * about research: which tools, how many steps, and what a finding has to be.
 *
 * Built per angle rather than declared at module scope, because {@link cite}
 * closes over the list it records into. That costs nothing: the runner memoizes
 * its model client per LLM DESCRIPTOR, and this names none — it takes the
 * gateway default `stepDelegate` binds.
 */
function researcher(cited: Source[]): SubagentDef {
  return subagent({
    name: "researcher",
    systemPrompt: RESEARCH_SYSTEM,
    expectedOutput: RESEARCH_OUTPUT,
    // The SAME implementations this file used to call directly — `web_search`
    // and `visit_webpage` are the builtins over `@alexkroman1/aai/tools`, URL
    // screening and size caps included.
    builtinTools: ["web_search", "visit_webpage"],
    tools: { cite: cite(cited) },
    maxSteps: RESEARCH_BUDGET,
  });
}

/**
 * `cite` — how a researcher says which sources it actually used.
 *
 * A tool rather than a field of a structured reply, because a subagent answers
 * with TEXT: what crosses back is its final message, so anything else it has to
 * tell the caller has to be told through a tool call. Recording it as it goes is
 * also the behaviour the prompt wants — a source list written at the end is a
 * list of what the model remembers reading.
 */
function cite(cited: Source[]): ToolDef {
  return tool({
    description:
      "Record a source you actually read and relied on. Call it as you go, once " +
      "per source — not at the end, and not for a result you only saw in a list.",
    inputSchema: z.object({
      title: z.string().max(200).describe("The page's title, as it calls itself"),
      url: z.url().describe("The page's URL"),
    }),
    execute: ({ title, url }) => {
      cited.push({ title, url });
      return "Recorded.";
    },
  });
}

/**
 * Investigate one angle.
 *
 * **The narration got COARSER and that is the trade.** Per-search reporting is
 * gone — the searches happen inside the subagent's own loop, where this body
 * cannot see them — so the page learns what an angle is doing when it starts and
 * what it cost when it finishes, rather than per query. Two angles run at once
 * (`ANGLE_CONCURRENCY`), so the stream still moves; buying the old granularity
 * back would mean wrapping each builtin in a narrating tool of this template's
 * own, which is most of the code the subagent just deleted.
 */
export async function investigate(brief: Brief, angle: string): Promise<Note> {
  await stepReport(`Looking into: ${angle}`);
  const cited: Source[] = [];

  const result = await stepDelegate(researcher(cited), {
    task: angle,
    // The researcher has not heard the call and cannot see its siblings, so the
    // brief rides in `context` — the same rule `angleBrief` states in
    // `briefing-desk`, and the reason a subagent's task must be complete.
    context: briefText(brief),
  });

  const work = countWork(result.toolCalls);
  await stepReport(
    `Finished ${angle}: ${work.searches} ${plural(work.searches, "search", "searches")}, ` +
      `${work.reads} ${plural(work.reads, "page")} read.`,
  );

  return {
    angle,
    findings: result.text,
    // What it SAID it used, falling back to what it actually opened. A
    // researcher that forgot to cite has still read pages, and reporting no
    // sources for a note full of findings is the worse of the two failures —
    // the report stage cites from this list.
    sources: cited.length > 0 ? dedupe(cited) : dedupe(work.opened),
  };
}

/** What one delegated run did, read off the calls it made. */
function countWork(toolCalls: readonly SubagentToolCall[]): {
  searches: number;
  reads: number;
  opened: Source[];
} {
  let searches = 0;
  const opened: Source[] = [];
  for (const call of toolCalls) {
    if (call.name === "web_search") searches += 1;
    else if (call.name === "visit_webpage") {
      // The builtin takes the URL as its whole input, so this is the one place
      // a raw tool input is read. Anything else shaped differently is skipped
      // rather than coerced — a `url` that is not a string is not a page.
      const url = readUrl(call.input);
      if (url) opened.push({ title: url, url });
    }
  }
  return { searches, reads: opened.length, opened };
}

/** The URL a `visit_webpage` call named, when it named one. */
function readUrl(input: unknown): string | undefined {
  if (typeof input === "string") return input;
  if (isRecord(input) && typeof input.url === "string" && input.url) return input.url;
  return undefined;
}

/**
 * The supervisor's second look.
 *
 * Bounded to one extra wave by construction — this is called once — because the
 * failure mode of an open-ended supervisor is a run that never converges, and a
 * caller who is told "still working" for twenty minutes.
 */
export async function findGaps(brief: Brief, notes: readonly Note[]): Promise<string[]> {
  if (notes.length === 0) return [];
  const parsed = await stepGenerateJsonOrFail(
    `${briefText(brief)}\n\nWhat came back:\n${notes.map(noteText).join("\n\n")}`,
    { system: GAPS_SYSTEM, schema: AnglesReply },
  );
  const gaps = parsed.angles.slice(0, MAX_ANGLES - 1);
  await stepReport(
    gaps.length === 0
      ? "The brief is covered; writing it up."
      : `Following up ${gaps.length} ${plural(gaps.length, "gap")}.`,
  );
  return gaps;
}

/**
 * Write the report, then the sentence a phone can carry.
 *
 * Two model calls in one step because they are one decision: the summary is a
 * reduction OF the report, and journaling them separately would let a resume
 * pair a new summary with an old report.
 */
export async function writeReport(
  topic: string,
  brief: Brief,
  notes: readonly Note[],
): Promise<{ report: string; summary: string }> {
  await stepReport(`Writing up ${notes.length} ${plural(notes.length, "angle")}.`);
  const written = await stepGenerateOrFail(
    `${briefText(brief)}\n\nFindings:\n${notes.map(noteText).join("\n\n")}`,
    { system: REPORT_SYSTEM },
  );
  const summary = await stepGenerateOrFail(`Topic: ${topic}\n\nReport:\n${written}`, {
    system: BRIEF_SUMMARY_SYSTEM,
  });
  return { report: written, summary };
}

// ---- Model plumbing ---------------------------------------------------------
//
// There is none left, and its absence is the point. This desk carried an `ask()`
// and an `askJson()` whose whole body was `.catch(throwStepError)`; the SDK's
// `stepGenerateOrFail` and `stepGenerateJsonOrFail`
// (`@alexkroman1/aai/step-errors`) ARE that call — the `/step` one with the
// gateway's verdict classified, so a terminal failure stays terminal and a rate
// limit becomes a `RetryableError` carrying the delay the gateway itself named.
// `stepGenerateJsonOrFail` also owns the four things every JSON stage used
// to re-derive — unwrap the fence, parse, reject a non-object, check the shape —
// and throws PLAINLY when any of them misses, which is what makes a malformed
// reply a retry rather than a failure.
