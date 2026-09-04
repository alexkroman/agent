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
 *   investigate     N steps   →  one researcher each: search, read, compress
 *   findGaps        1 step    →  the supervisor's second look
 *   investigate     M steps   →  the second wave, when there is one
 *   writeReport     1 step    →  the report, then the sentence for the phone
 *   sleep + file    1 step    →  the review wait, then filing
 * ```
 *
 * ## A step can do what a TOOL can do, and that is what makes this real
 *
 * `investigate` calls `webSearch` and `visitWebpage` from
 * `@alexkroman1/aai/tools` — the SAME implementations behind the model-facing
 * builtins, with the same URL screening, redirect re-validation and size caps.
 * A step is not a lesser environment than a tool body: it is bundled with
 * everything it imports, so anything a tool can reach it can reach. Before this,
 * this template's "research" was three model calls asking a model what it
 * already believed, which is the thing deep research exists not to be.
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
 */

import type { WorkflowCtx } from "@alexkroman1/aai";
import { mapConcurrent, stepReport } from "@alexkroman1/aai/step";
import { stepGenerateJsonOrFail, stepGenerateOrFail } from "@alexkroman1/aai/step-errors";
import { visitWebpage, webSearch } from "@alexkroman1/aai/tools";
import { errorMessage, isToolFailure, plural } from "@alexkroman1/aai/utils";
import { z } from "zod";
import {
  BRIEF_SUMMARY_SYSTEM,
  BRIEF_SYSTEM,
  COMPRESS_SYSTEM,
  GAPS_SYSTEM,
  PLAN_SYSTEM,
  REPORT_SYSTEM,
  RESEARCH_SYSTEM,
} from "./prompts.ts";

/**
 * Angles investigated at once. The far side of every one is a rate limit.
 *
 * Inside `DEFAULT_STEP_CONCURRENCY` (`aai-runtime`, 16), so this width is what
 * really runs — see "The WINDOW is not the concurrency" in `mapConcurrent`.
 */
const ANGLE_CONCURRENCY = 2;

/**
 * How long the desk sits on a finished report before filing it.
 *
 * Short enough to watch in `aai dev`. Nothing about this file changes if it is
 * `"6 hours"` — which is the interesting version, and the one a real desk would
 * use; what makes either affordable is that the run is SUSPENDED rather than
 * blocked, so the sandbox is free to exit and the run resumes when it comes due.
 */
export const REVIEW_DELAY_MS = 30_000;

/** Most angles a wave may carry, whatever the supervisor asks for. */
const MAX_ANGLES = 4;

/**
 * Actions one researcher may take before it must stop.
 *
 * The budget is the mechanism, not the prompt: a model told to stop when it
 * has enough will sometimes not, and a run whose cost is decided by a model is
 * a run nobody can price. Six covers "search, read, search, read" with room to
 * follow one lead.
 */
const RESEARCH_BUDGET = 6;

/** Characters of a page kept for the compression stage. */
const MAX_PAGE_CHARS = 6000;

/** Results asked for per search. Beyond this they stop being about the query. */
const SEARCH_RESULTS = 5;

/** One source a researcher actually used. */
export type Source = { title: string; url: string };

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

/** One cited source, as the compression stage is asked to report it. */
const CitedSource = z.object({ title: z.string(), url: z.string() });

/** The cited sources, with any malformed entry dropped rather than fatal. */
const CitedSources = z.array(z.unknown()).transform((items) =>
  items.flatMap((item) => {
    const parsed = CitedSource.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  }),
);

/** What `writeBrief` asks for. */
const BriefReply = z.object({ brief: z.string().trim().optional(), criteria: StringList });

/** What `planAngles` and `findGaps` ask for. */
const AnglesReply = z.object({ angles: StringList });

/**
 * What one turn of the researcher's loop asks for.
 *
 * `.catch("stop")` is the old `parsed.action === "search" || …` guard: an action
 * the model did not name is a stop, not a fatal reply, because the budget is
 * better spent than burned on turns that cannot do anything.
 */
const ActionReply = z.object({
  action: z.enum(["search", "read", "stop"]).catch("stop"),
  query: z.string().optional(),
  url: z.string().optional(),
  why: z.string().optional(),
});

/**
 * What `compress` asks for.
 *
 * `sources` is `.catch(undefined)` rather than merely optional, and the
 * distinction is the one this whole stage turns on: a model that returned
 * something unusable there should fall back to the sources the researcher was
 * ACTUALLY shown, not throw the compressed findings away and research the angle
 * again.
 */
const CompressReply = z.object({
  findings: z.string().optional(),
  sources: CitedSources.optional().catch(undefined),
});

/** What one researcher concluded about one angle. */
export type Note = {
  angle: string;
  /** The compressed findings — kept long on purpose; a later step summarizes. */
  findings: string;
  sources: Source[];
};

/** The research brief, as `writeBrief` settles it. */
export type Brief = {
  brief: string;
  /** What a complete answer has to contain — what `findGaps` measures against. */
  criteria: string[];
};

/** What one research pass produces. */
export type Findings = {
  topic: string;
  /** Two sentences, for an agent to read down a phone. */
  summary: string;
  /** The written report — markdown, cited. What a page renders. */
  report: string;
  /** How many distinct sources were used, which is what the voice agent quotes. */
  sources: number;
  angles: string[];
};

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
  ctx: WorkflowCtx,
) {
  const brief = await ctx.step("writeBrief", () => writeBrief(input.topic));
  const angles = await ctx.step("planAngles", () => planAngles(brief));

  // One step per angle, bounded, in an order a replay reproduces exactly —
  // `mapConcurrent` hands out items from a monotonic cursor, so the Nth call
  // ISSUED is item N whatever order they settle in, and the Nth call is
  // `investigate#N`. A failed angle fails the RUN: its finished siblings are
  // already journaled, so the resume replays them for free and re-issues only
  // what is missing, where catching here would file a report with a silent hole
  // in it. `maxAttempts: 5` was `investigate.maxRetries = 4`.
  const first = await mapConcurrent(angles, ANGLE_CONCURRENCY, (angle) =>
    ctx.step("investigate", () => investigate(brief, angle), { maxAttempts: 5 }),
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
    ctx.step("investigateGap", () => investigate(brief, angle), { maxAttempts: 5 }),
  );

  const notes = [...first, ...second];
  const written = await ctx.step("writeReport", () => writeReport(input.topic, brief, notes));

  // Suspended, not blocked. On resume the body re-runs from the top and every
  // step above returns its journaled result rather than researching again —
  // which is also what `file_it_now` ends early, through `ctx.workflows.wakeUp`.
  await ctx.sleep("reviewWindow", REVIEW_DELAY_MS);

  // Whatever this returns is what `ctx.workflows.get(runId)` reports as `output`
  // on a completed run — so it is what the agent reads back, and what the
  // announcement is built from.
  return {
    topic: input.topic,
    summary: written.summary,
    report: written.report,
    sources: countSources(notes),
    angles: notes.map((note) => note.angle),
    filedAt: await ctx.step("file", () => file(input.requestedBy, input.topic)),
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
 * Investigate one angle: search, read, stop, compress.
 *
 * The loop is the researcher — the model chooses each action and the budget is
 * what ends it. Everything it saw is kept as raw material for the compression
 * at the end, which is where it becomes small enough to journal.
 */
export async function investigate(brief: Brief, angle: string): Promise<Note> {
  await stepReport(`Looking into: ${angle}`);
  const seen: string[] = [];
  const sources: Source[] = [];

  for (let spent = 0; spent < RESEARCH_BUDGET; spent++) {
    const action = await nextAction(brief, angle, seen, RESEARCH_BUDGET - spent);
    if (action.action === "stop") break;
    if (action.action === "search" && action.query) {
      const found = await search(action.query);
      seen.push(`SEARCH ${action.query}\n${found.summary}`);
      sources.push(...found.sources);
      continue;
    }
    if (action.action === "read" && action.url) {
      await stepReport(`Reading ${hostname(action.url)}`);
      seen.push(`PAGE ${action.url}\n${await readPage(action.url)}`);
      continue;
    }
    // An action the model did not fill in: stop rather than spend the budget on
    // turns that cannot do anything.
    break;
  }

  return await compress(angle, seen, sources);
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

/**
 * File the finished research.
 *
 * `ctx.db` is the one half of a tool context a step still does not get, so this
 * writes nothing and says so rather than naming a call it cannot make. The
 * parameters carry `_` for the same reason.
 */
export async function file(_requestedBy: string, _topic: string): Promise<string> {
  await stepReport("Filing the findings.");
  return "filed";
}

// ---- The researcher's own calls ---------------------------------------------

/** What the model wants to do next. */
type Action = z.infer<typeof ActionReply>;

/** Ask the model for one action, given everything the researcher has seen. */
async function nextAction(
  brief: Brief,
  angle: string,
  seen: readonly string[],
  left: number,
): Promise<Action> {
  return await stepGenerateJsonOrFail(
    `${briefText(brief)}\n\nYour angle: ${angle}\n` +
      `Actions left: ${left}\n\n` +
      (seen.length === 0 ? "You have not looked at anything yet." : seen.join("\n\n")),
    { system: RESEARCH_SYSTEM, schema: ActionReply },
  );
}

/**
 * One search, through the SAME implementation the `web_search` builtin uses.
 *
 * A failed search is not a failed angle, and the failure goes back into `seen`
 * rather than only into the log: the researcher's next turn is chosen from what
 * it has been shown, so a search that quietly returned nothing reads as "no such
 * pages exist" and gets run again, differently worded, until the budget is gone.
 */
async function search(query: string): Promise<{ summary: string; sources: Source[] }> {
  await stepReport(`Searching: ${query}`);
  try {
    const results = await webSearch<{ results?: { title?: string; url?: string }[] }>({
      query,
      maxResults: SEARCH_RESULTS,
    });
    // The `catch` below was written for exactly this and could not reach it:
    // `webSearch` ANSWERS with `{ error }` rather than throwing, so a refused
    // search arrived here as an empty result list and was reported to the
    // researcher as "No results." — the thing this function's doc says not to do.
    if (isToolFailure(results)) throw new Error(results.error);
    const sources = (results.results ?? [])
      .filter((one): one is { title: string; url: string } =>
        Boolean(typeof one.url === "string" && one.url),
      )
      .map((one) => ({ title: one.title || one.url, url: one.url }));
    return {
      summary: sources.length === 0 ? "No results." : sources.map(describeResult).join("\n"),
      sources,
    };
  } catch (err: unknown) {
    const summary = `That search failed: ${errorMessage(err)}`;
    await stepReport(summary);
    return { summary, sources: [] };
  }
}

/** One page, capped — the compression stage reads this, not a browser. */
async function readPage(url: string): Promise<string> {
  try {
    const page = await visitWebpage<{ content?: string; text?: string }>(url);
    // Same rule as the search above: an unreadable page ANSWERS with `{ error }`,
    // and `?? ""` would put an empty note in front of the compression stage —
    // which reads as "this page said nothing" rather than "we never read it".
    if (isToolFailure(page)) throw new Error(page.error);
    return String(page.content ?? page.text ?? "").slice(0, MAX_PAGE_CHARS);
  } catch (err: unknown) {
    return `Could not read this page: ${errorMessage(err)}`;
  }
}

/**
 * Compress what one researcher saw into a journaled note.
 *
 * The stage that keeps a step's result small enough to carry, and the one whose
 * prompt says to REPEAT rather than summarize: a summary of a summary is how a
 * long research pass ends in a confident, sourceless paragraph.
 */
async function compress(angle: string, seen: readonly string[], sources: Source[]): Promise<Note> {
  if (seen.length === 0) {
    return { angle, findings: "Nothing was found on this angle.", sources: [] };
  }
  const parsed = await stepGenerateJsonOrFail(`Angle: ${angle}\n\n${seen.join("\n\n")}`, {
    system: COMPRESS_SYSTEM,
    schema: CompressReply,
  });
  return {
    angle,
    findings: parsed.findings ?? seen.join("\n\n"),
    // A model that cited nothing at all falls back to what the researcher was
    // actually shown, which is the honest answer and not an empty one.
    sources: parsed.sources ?? dedupe(sources).slice(0, SEARCH_RESULTS),
  };
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

// ---- Pure helpers -----------------------------------------------------------

/** The brief as the models are shown it. */
function briefText(brief: Brief): string {
  const criteria = brief.criteria.map((one) => `- ${one}`).join("\n");
  return criteria
    ? `Brief: ${brief.brief}\n\nA complete answer covers:\n${criteria}`
    : `Brief: ${brief.brief}`;
}

/** One note, as a later stage reads it. */
function noteText(note: Note): string {
  const cited = note.sources.map((one, at) => `[${at + 1}] ${one.title} — ${one.url}`).join("\n");
  return `## ${note.angle}\n${note.findings}\n${cited}`;
}

/** One search result, as the researcher sees it. */
function describeResult(source: Source): string {
  return `- ${source.title} — ${source.url}`;
}

/** Distinct sources by URL, first occurrence winning. */
export function dedupe(sources: readonly Source[]): Source[] {
  const byUrl = new Map<string, Source>();
  for (const one of sources) if (!byUrl.has(one.url)) byUrl.set(one.url, one);
  return [...byUrl.values()];
}

/** How many distinct sources the whole pass rests on — what the agent quotes. */
export function countSources(notes: readonly Note[]): number {
  return dedupe(notes.flatMap((note) => note.sources)).length;
}

/** A URL's host, for a progress line a listener can follow. */
function hostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
