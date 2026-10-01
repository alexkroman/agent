// Copyright 2026 the AAI authors. MIT license.
/**
 * The steps of a deep-research pass — what `deepResearchWorkflow`'s body wraps
 * in `ctx.step` — and the pure readers they format with.
 *
 * Every function here takes the resolved {@link DeepResearchSettings} and no
 * `ctx`, so a spec drives each against the stub gateway and the stub delegate
 * with no engine. Only {@link citedSources} is on a subpath.
 *
 * @module
 */

import { z } from "zod";
import type {
  DeepResearchBrief,
  DeepResearchNote,
  DeepResearchSettings,
  DeepResearchSource,
} from "./deep-research-types.ts";
import { tool } from "./define.ts";
import { plural } from "./format.ts";
import { isRecord } from "./is-record.ts";
import { omitUndefined } from "./omit-undefined.ts";
import { type DelegateToolCall, type SpeakerDef, speaker } from "./speaker.ts";
import { stepDelegate } from "./step-delegate.ts";
import { stepGenerate } from "./step-generate.ts";
import { stepGenerateJson } from "./step-generate-json.ts";
import { stepReport } from "./step-report.ts";
import { orFail } from "./tool-failure-flow.ts";
import type { ToolDef } from "./types.ts";

// ---- The stages ------------------------------------------------------------

/** A model's array of strings, with everything else dropped — one bad element costs that element. */
const StringList = z
  .array(z.unknown())
  .transform((values) =>
    values.filter((value): value is string => typeof value === "string" && value.trim().length > 0),
  )
  .catch([]);
const BriefReply = z.object({ brief: z.string().trim().optional(), criteria: StringList });
const AnglesReply = z.object({ angles: StringList });

/** Turn the request into a brief, falling back to the topic itself. */
export async function writeBrief(
  topic: string,
  settings: DeepResearchSettings,
): Promise<DeepResearchBrief> {
  await stepReport(`Working out what "${topic}" is really asking.`);
  const parsed = await orFail(stepGenerateJson)(`Research request, as it was asked: ${topic}`, {
    ...settings.generate,
    system: settings.prompts.brief,
    schema: BriefReply,
  });
  return {
    brief: parsed.brief || topic,
    criteria: parsed.criteria.slice(0, settings.budget.maxAngles),
  };
}

/** The angles worth pursuing; the brief itself when none come back. */
export async function planAngles(
  brief: DeepResearchBrief,
  settings: DeepResearchSettings,
): Promise<string[]> {
  const parsed = await orFail(stepGenerateJson)(briefText(brief), {
    ...settings.generate,
    system: settings.prompts.plan,
    schema: AnglesReply,
  });
  const angles = parsed.angles.slice(0, Math.max(1, settings.budget.maxAngles));
  if (angles.length === 0) {
    await stepReport("No angles came back; researching the brief itself.");
    return [brief.brief];
  }
  await stepReport(`Researching ${angles.length} ${plural(angles.length, "angle")}.`);
  return angles;
}

/** A subagent answers with text, so the sources it used come back through a tool. */
function cite(cited: DeepResearchSource[]): ToolDef {
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

/** Built per angle, because `cite` closes over the list it records into. */
function researcher(cited: DeepResearchSource[], settings: DeepResearchSettings): SpeakerDef {
  const { builtinTools, tools, llm } = settings.researcher;
  return speaker({
    name: "researcher",
    systemPrompt: settings.prompts.research,
    expectedOutput: settings.prompts.researchOutput,
    builtinTools: builtinTools ?? ["web_search", "visit_webpage"],
    tools: { ...tools, cite: cite(cited) },
    maxSteps: settings.budget.researcherSteps,
    ...omitUndefined({ llm }),
  });
}

/** Investigate one angle: the whole search loop, journaled as what it CONCLUDED. */
export async function investigate(
  brief: DeepResearchBrief,
  angle: string,
  settings: DeepResearchSettings,
): Promise<DeepResearchNote> {
  await stepReport(`Looking into: ${angle}`);
  const cited: DeepResearchSource[] = [];
  // The researcher has not heard the request and cannot see its siblings, so the
  // brief rides in `context`.
  const result = await stepDelegate(researcher(cited, settings), {
    task: angle,
    context: briefText(brief),
  });
  const work = countWork(result.toolCalls);
  await stepReport(
    `Finished ${angle}: ${work.searches} ${plural(work.searches, "search", "searches")}, ` +
      `${work.reads} ${plural(work.reads, "page")} read.`,
  );
  // What it SAID it used, falling back to what it opened: a note full of
  // findings reporting no sources is the worse of the two failures.
  return { angle, findings: result.text, sources: dedupe(cited.length > 0 ? cited : work.opened) };
}

/** What one delegated run did, read off the calls it made. */
function countWork(toolCalls: readonly DelegateToolCall[]): {
  searches: number;
  reads: number;
  opened: DeepResearchSource[];
} {
  let searches = 0;
  const opened: DeepResearchSource[] = [];
  for (const call of toolCalls) {
    if (call.name === "visit_webpage") {
      const url = readUrl(call.input);
      if (url) opened.push({ title: url, url });
    } else if (call.name.endsWith("search")) searches += 1;
  }
  return { searches, reads: opened.length, opened };
}

/** The URL a `visit_webpage` call named, when it named one. */
function readUrl(input: unknown): string | undefined {
  if (typeof input === "string") return input || undefined;
  if (isRecord(input) && typeof input.url === "string" && input.url) return input.url;
  return undefined;
}

/** The supervisor's second look. Asks nothing when the first wave found nothing. */
export async function findGaps(
  brief: DeepResearchBrief,
  notes: readonly DeepResearchNote[],
  settings: DeepResearchSettings,
): Promise<string[]> {
  if (notes.length === 0) return [];
  const parsed = await orFail(stepGenerateJson)(
    `${briefText(brief)}\n\nWhat came back:\n${notes.map(noteText).join("\n\n")}`,
    { ...settings.generate, system: settings.prompts.gaps, schema: AnglesReply },
  );
  const gaps = parsed.angles.slice(0, settings.budget.maxGapAngles);
  await stepReport(
    gaps.length === 0
      ? "The brief is covered; writing it up."
      : `Following up ${gaps.length} ${plural(gaps.length, "gap")}.`,
  );
  return gaps;
}

/**
 * The report, then the summary, in ONE step: the summary is a reduction OF the
 * report, and journaled apart a resume could pair a new one with an old report.
 */
export async function writeReport(
  topic: string,
  brief: DeepResearchBrief,
  notes: readonly DeepResearchNote[],
  settings: DeepResearchSettings,
): Promise<{ report: string; summary: string }> {
  await stepReport(`Writing up ${notes.length} ${plural(notes.length, "angle")}.`);
  const report = await orFail(stepGenerate)(
    `${briefText(brief)}\n\n${findingsText(notes, allSources(notes))}`,
    { ...settings.generate, system: settings.prompts.report },
  );
  const summary = await orFail(stepGenerate)(`Topic: ${topic}\n\nReport:\n${report}`, {
    ...settings.generate,
    system: settings.prompts.summary,
  });
  return { report, summary };
}

// ---- Pure readers ------------------------------------------------------------

/** The brief as the models are shown it. */
function briefText(brief: DeepResearchBrief): string {
  const criteria = brief.criteria.map((one) => `- ${one}`).join("\n");
  return criteria
    ? `Brief: ${brief.brief}\n\nA complete answer covers:\n${criteria}`
    : `Brief: ${brief.brief}`;
}

/** One note, as the gap pass reads it. */
function noteText(note: DeepResearchNote): string {
  const cited = note.sources.map((one) => `- ${one.title} (${one.url})`).join("\n");
  return `## ${note.angle}\n${note.findings}\n${cited}`;
}

/**
 * Every note, with ONE numbering of every source across them, for the report.
 * Each note's own list would restart at [1], and the report's citations could
 * not be mapped back to URLs.
 */
export function findingsText(
  notes: readonly DeepResearchNote[],
  sources: readonly DeepResearchSource[],
): string {
  const number = new Map(sources.map((one, at) => [one.url, at + 1]));
  const body = notes.map((note) => {
    const cited = note.sources.map((one) => `[${number.get(one.url)}]`).join(" ");
    return `## ${note.angle}\n${note.findings}\nSources used here: ${cited || "none"}`;
  });
  const list = sources.map((one, at) => `[${at + 1}] ${one.title} (${one.url})`).join("\n");
  return `${body.join("\n\n")}\n\nSources:\n${list}`;
}

/**
 * The sources a report actually cites, each with the number it was cited
 * under, in source order — so a consumer can append real URLs rather than trust
 * ones a model retyped. A number with no source behind it is dropped, not
 * invented.
 *
 * @example
 * ```ts
 * import { citedSources, type DeepResearchResult } from "@alexkroman1/aai/experimental";
 *
 * declare const result: DeepResearchResult;
 * const lines = citedSources(result.report, result.sources).map((s) => `[${s.number}] ${s.url}`);
 * ```
 *
 * @public
 */
export function citedSources(
  report: string,
  sources: readonly DeepResearchSource[],
): (DeepResearchSource & { readonly number: number })[] {
  const used = new Set([...report.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
  return sources.flatMap((one, at) => (used.has(at + 1) ? [{ ...one, number: at + 1 }] : []));
}

/** Distinct sources by URL, first occurrence winning. */
function dedupe(sources: readonly DeepResearchSource[]): DeepResearchSource[] {
  const byUrl = new Map<string, DeepResearchSource>();
  for (const one of sources) if (!byUrl.has(one.url)) byUrl.set(one.url, one);
  return [...byUrl.values()];
}

/** Every distinct source the pass rests on, in the order found. */
export function allSources(notes: readonly DeepResearchNote[]): DeepResearchSource[] {
  return dedupe(notes.flatMap((note) => note.sources));
}
