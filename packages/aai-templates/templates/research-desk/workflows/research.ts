// Copyright 2026 the AAI authors. MIT license.
/**
 * The durable half of the research desk: a real deep-research pass.
 *
 * Read `transcription-desk/workflows/transcribe.ts` for the rules every
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
 * `report()` (`@alexkroman1/aai/utils`) writes to the run's own stream — which
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

import { visitWebpage, webSearch } from "@alexkroman1/aai/tools";
import {
  mapInBatches,
  report,
  StepGenerateError,
  safeJsonParse,
  stepGenerate,
} from "@alexkroman1/aai/utils";
import { FatalError, sleep } from "workflow";
import {
  BRIEF_SUMMARY_SYSTEM,
  BRIEF_SYSTEM,
  COMPRESS_SYSTEM,
  GAPS_SYSTEM,
  PLAN_SYSTEM,
  REPORT_SYSTEM,
  RESEARCH_SYSTEM,
} from "./prompts.ts";

/** Angles investigated at once. The far side of every one is a rate limit. */
const ANGLE_CONCURRENCY = 2;

/**
 * How long the desk sits on a finished report before filing it.
 *
 * Short enough to watch in `aai dev`. Nothing about this file changes if it is
 * `"6 hours"` — which is the interesting version, and the one a real desk would
 * use; what makes either affordable is that the run is SUSPENDED rather than
 * blocked, so the sandbox is free to exit and the run resumes when it comes due.
 */
const REVIEW_DELAY = "30 seconds";

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
 * The `sleep` on top is the review wait — the one suspension in the template,
 * and what `file_it_now` skips with `wakeUp`.
 */
export async function researchFlow(input: { topic: string; requestedBy: string }) {
  "use workflow";

  const brief = await writeBrief(input.topic);
  const angles = await planAngles(brief);

  // One step per angle, bounded, in an order a replay reproduces exactly. A
  // failed angle fails the RUN: its finished siblings are already journaled, so
  // the resume replays them for free and re-issues only what is missing, where
  // catching here would file a report with a silent hole in it.
  const first = await mapInBatches(angles, ANGLE_CONCURRENCY, (angle) => investigate(brief, angle));

  // The supervisor's second look. Usually empty — a second wave costs the caller
  // minutes, and the prompt says so.
  const gaps = await findGaps(brief, first);
  const second = await mapInBatches(gaps, ANGLE_CONCURRENCY, (angle) => investigate(brief, angle));

  const notes = [...first, ...second];
  const written = await writeReport(input.topic, brief, notes);

  // Suspended, not blocked. On resume the body re-runs from the top and every
  // step above returns its journaled result rather than researching again —
  // which is also what `file_it_now` ends early, through `wakeUp`.
  await sleep(REVIEW_DELAY);

  // Whatever this returns is what `ctx.workflows.get(runId)` reports as `output`
  // on a completed run — so it is what the agent reads back, and what the
  // announcement is built from.
  return {
    topic: input.topic,
    summary: written.summary,
    report: written.report,
    sources: countSources(notes),
    angles: notes.map((note) => note.angle),
    filedAt: await file(input.requestedBy, input.topic),
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
  "use step";

  await report(`Working out what "${topic}" is really asking.`);
  const parsed = await askJson<Partial<Brief>>(
    `Research request, as the caller said it: ${topic}`,
    BRIEF_SYSTEM,
  );
  const brief = typeof parsed.brief === "string" && parsed.brief.trim() ? parsed.brief : topic;
  return { brief, criteria: strings(parsed.criteria).slice(0, MAX_ANGLES) };
}

/**
 * Break the brief into the angles worth pursuing.
 *
 * The fan-out's WIDTH comes from this step's journaled result, which is the
 * ordinary determinism rule: a replay re-derives the same list rather than
 * asking the model again and getting a different one.
 */
export async function planAngles(brief: Brief): Promise<string[]> {
  "use step";

  const parsed = await askJson<{ angles?: unknown }>(briefText(brief), PLAN_SYSTEM);
  const angles = strings(parsed.angles).slice(0, MAX_ANGLES);
  if (angles.length === 0) {
    // Nothing to fan out over is a plan failure, not an empty result: the brief
    // itself is the one angle that is always available.
    await report("No angles came back; researching the brief itself.");
    return [brief.brief];
  }
  await report(`Researching ${angles.length} angle${angles.length === 1 ? "" : "s"}.`);
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
  "use step";

  await report(`Looking into: ${angle}`);
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
      await report(`Reading ${hostname(action.url)}`);
      seen.push(`PAGE ${action.url}\n${await readPage(action.url)}`);
      continue;
    }
    // An action the model did not fill in: stop rather than spend the budget on
    // turns that cannot do anything.
    break;
  }

  return await compress(angle, seen, sources);
}

/** Retries beyond the default: the far side is a search engine and a model. */
investigate.maxRetries = 4;

/**
 * The supervisor's second look.
 *
 * Bounded to one extra wave by construction — this is called once — because the
 * failure mode of an open-ended supervisor is a run that never converges, and a
 * caller who is told "still working" for twenty minutes.
 */
export async function findGaps(brief: Brief, notes: readonly Note[]): Promise<string[]> {
  "use step";

  if (notes.length === 0) return [];
  const parsed = await askJson<{ angles?: unknown }>(
    `${briefText(brief)}\n\nWhat came back:\n${notes.map(noteText).join("\n\n")}`,
    GAPS_SYSTEM,
  );
  const gaps = strings(parsed.angles).slice(0, MAX_ANGLES - 1);
  await report(
    gaps.length === 0
      ? "The brief is covered; writing it up."
      : `Following up ${gaps.length} gap${gaps.length === 1 ? "" : "s"}.`,
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
  "use step";

  await report(`Writing up ${notes.length} angle${notes.length === 1 ? "" : "s"}.`);
  const written = await ask(
    `${briefText(brief)}\n\nFindings:\n${notes.map(noteText).join("\n\n")}`,
    REPORT_SYSTEM,
  );
  const summary = await ask(`Topic: ${topic}\n\nReport:\n${written}`, BRIEF_SUMMARY_SYSTEM);
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
  "use step";

  await report("Filing the findings.");
  return "filed";
}

// ---- The researcher's own calls ---------------------------------------------

/** What the model wants to do next. */
type Action = { action: "search" | "read" | "stop"; query?: string; url?: string; why?: string };

/** Ask the model for one action, given everything the researcher has seen. */
async function nextAction(
  brief: Brief,
  angle: string,
  seen: readonly string[],
  left: number,
): Promise<Action> {
  const parsed = await askJson<Action>(
    `${briefText(brief)}\n\nYour angle: ${angle}\n` +
      `Actions left: ${left}\n\n` +
      (seen.length === 0 ? "You have not looked at anything yet." : seen.join("\n\n")),
    RESEARCH_SYSTEM,
  );
  return parsed.action === "search" || parsed.action === "read" || parsed.action === "stop"
    ? parsed
    : { action: "stop", why: "no action" };
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
  await report(`Searching: ${query}`);
  try {
    const results = await webSearch<{ results?: { title?: string; url?: string }[] }>({
      query,
      max_results: SEARCH_RESULTS,
    });
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
    const summary = `That search failed: ${message(err)}`;
    await report(summary);
    return { summary, sources: [] };
  }
}

/** One page, capped — the compression stage reads this, not a browser. */
async function readPage(url: string): Promise<string> {
  try {
    const page = await visitWebpage<{ content?: string; text?: string }>(url);
    return String(page.content ?? page.text ?? "").slice(0, MAX_PAGE_CHARS);
  } catch (err: unknown) {
    return `Could not read this page: ${message(err)}`;
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
  const parsed = await askJson<{ findings?: unknown; sources?: unknown }>(
    `Angle: ${angle}\n\n${seen.join("\n\n")}`,
    COMPRESS_SYSTEM,
  );
  const findings = typeof parsed.findings === "string" ? parsed.findings : seen.join("\n\n");
  const cited = Array.isArray(parsed.sources)
    ? parsed.sources.filter(isSource)
    : dedupe(sources).slice(0, SEARCH_RESULTS);
  return { angle, findings, sources: cited };
}

// ---- Model plumbing ---------------------------------------------------------

/**
 * `stepGenerate`, with this desk's retry POLICY on top.
 *
 * The SDK classifies the failure (`StepGenerateError.retryable`) and stops
 * there, deliberately: whether a terminal failure should burn the step's
 * remaining attempts is the caller's call, and `FatalError` belongs to
 * `workflow`, which the SDK cannot import onto the CLI's startup path.
 */
async function ask(prompt: string, system: string): Promise<string> {
  return await stepGenerate(prompt, { system }).catch(stopOrRetry);
}

/**
 * The same call, for a stage whose reply is JSON.
 *
 * A reply that ignored the format throws PLAINLY rather than fatally — a model
 * may well obey on the next attempt, which is exactly what a retry is for.
 */
async function askJson<T>(prompt: string, system: string): Promise<T> {
  const raw = await ask(prompt, system);
  const parsed = safeJsonParse(stripFence(raw));
  if (parsed === null || typeof parsed !== "object") {
    throw new Error(`Expected JSON from the model, got: ${raw.slice(0, 200)}`);
  }
  return parsed as T;
}

/**
 * Turn a terminal gateway failure into one the DevKit will not retry.
 *
 * A plain function rather than a `throw` inside a `catch`: `FatalError` takes
 * only a message — no `cause` — so constructing one in a catch block loses the
 * original error where the linter (rightly) expects it preserved.
 */
function stopOrRetry(err: unknown): never {
  if (err instanceof StepGenerateError && !err.retryable) throw new FatalError(err.message);
  throw err;
}

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

/** A model's array of strings, with everything else dropped. */
export function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((one): one is string => typeof one === "string" && one.trim().length > 0);
}

/** Is this the source shape the compression stage promised? */
function isSource(value: unknown): value is Source {
  if (value === null || typeof value !== "object") return false;
  const source = value as Partial<Source>;
  return typeof source.title === "string" && typeof source.url === "string";
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

/**
 * A fenced JSON reply, unfenced.
 *
 * Models wrap JSON in ```json fences often enough that refusing one costs a
 * whole retry for a reply that was otherwise correct.
 */
export function stripFence(raw: string): string {
  const fenced = /^\s*```(?:json)?\s*\n([\s\S]*?)\n?\s*```\s*$/.exec(raw);
  return fenced?.[1] ?? raw;
}

/** A URL's host, for a progress line a listener can follow. */
function hostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** An error's message, without the SDK's `errorMessage` import for one use. */
function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
