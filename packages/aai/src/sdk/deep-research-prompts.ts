// Copyright 2026 the AAI authors. MIT license.
/**
 * The default prompts {@link deepResearchWorkflow} runs on, one per stage.
 *
 * **Adapted from LangChain's `open_deep_research`** (MIT,
 * <https://github.com/langchain-ai/open_deep_research>,
 * `src/open_deep_research/prompts.py`), by way of `research-handoff-agent`,
 * which ported them first. What that project got right, and a naive research
 * pipeline gets wrong, is that every stage has an explicit STOP condition and an
 * explicit budget: a researcher told "search until you know enough" either stops
 * at the first plausible page or never stops at all.
 *
 * | open_deep_research | here |
 * | --- | --- |
 * | research brief | `brief` — one call, before anything is searched |
 * | lead researcher / supervisor | `plan`, then `gaps` for the second wave |
 * | researcher | `research` — the search loop, bounded by `maxSteps` |
 * | compress | `researchOutput` — the researcher's own `expectedOutput` |
 * | final report | `report`, plus `summary` for a voice agent to say |
 *
 * These are the NEUTRAL versions: they know the request may have been spoken
 * and that a voice agent may read the summary, and nothing about which product
 * is asking. A consumer overrides the stages whose audience it knows better —
 * a phone desk's brief, a speaker's summary, a report that has to fit a text
 * message — and keeps the rest. The shape of each reply is NOT written here:
 * `stepGenerateJson` appends the schema, so it cannot drift from what is
 * checked; what stays is what the fields must CONTAIN.
 *
 * @module
 */

/**
 * The prompt for each stage of a deep-research pass. Every field is optional
 * on {@link DeepResearchOptions.prompts}; an omitted one is the default here.
 *
 * @public
 */
export interface DeepResearchPrompts {
  /** Turns the request into a brief: `brief` (what, for whom) and `criteria` (what a complete answer contains). */
  readonly brief?: string | undefined;
  /** Breaks the brief into independent `angles` — the fan-out's width. */
  readonly plan?: string | undefined;
  /** The researcher's system prompt: how hard to look, when to stop, and to call `cite`. */
  readonly research?: string | undefined;
  /** The researcher's `expectedOutput` — what its final message, the only thing that crosses back, must be. */
  readonly researchOutput?: string | undefined;
  /** The supervisor's second look: which `angles` are still unanswered (an empty list ends the pass). */
  readonly gaps?: string | undefined;
  /** Writes the report from the findings and a numbered Sources list. */
  readonly report?: string | undefined;
  /** Reduces the report to what a voice agent can say out loud. */
  readonly summary?: string | undefined;
}

/**
 * The defaults behind {@link DeepResearchPrompts}, exported so a consumer can
 * compose against one (`${DEFAULT_DEEP_RESEARCH_PROMPTS.report} Plain text only.`)
 * rather than copy it.
 *
 * @public
 */
export const DEFAULT_DEEP_RESEARCH_PROMPTS: Readonly<Record<keyof DeepResearchPrompts, string>> = {
  brief: [
    "You turn a research request into a research brief.",
    "The request was probably spoken, so it may be short and ambiguous.",
    "Do NOT ask questions — you cannot; the person who asked is not here. Instead,",
    "state the most reasonable reading of the request and say what would make the",
    "answer good.",
    "`brief` is two or three sentences naming what is being researched and for whom.",
    "`criteria` is two to four things a complete answer must contain.",
  ].join(" "),
  plan: [
    "You are a research supervisor. Break a research brief into independent angles,",
    "each of which one researcher can investigate on its own.",
    "Bias towards FEWER angles: use one when the brief is a single question, and",
    "only add angles where a genuinely separate line of enquiry exists. Two",
    "researchers covering the same ground is the failure to avoid.",
    "`angles` lists them, each one short noun phrase, specific enough to search for.",
  ].join(" "),
  research: [
    "You are a researcher working on one angle of a research brief.",
    "Search the web, read the pages worth reading, and cite what you use.",
    "",
    "Rules for how hard to look:",
    "- A simple, factual angle deserves 2 to 3 searches. A comparative or",
    "  contested one deserves up to the budget you are given.",
    "- STOP as soon as one of these is true: you can answer the angle thoroughly;",
    "  you have three or more relevant sources agreeing; the last two searches",
    "  returned much the same thing.",
    "- Prefer READING a promising result over running another search. A page you",
    "  have opened is worth more than a fourth list of titles.",
    "- Call `cite` for each source you actually relied on, as you go rather than",
    "  at the end. A source you did not read is not a source.",
  ].join("\n"),
  researchOutput: [
    "Everything you found that bears on the angle, written out cleanly — repeat",
    "the relevant text rather than summarizing it away. A later stage does the",
    "summarizing and can only work with what you keep, so length is not the thing",
    "to economize on here.",
    "Mark each claim with the source you took it from. If you could not establish",
    "something, say so rather than guessing at it — including when the budget ran",
    "out before you were satisfied.",
  ].join(" "),
  gaps: [
    "You are a research supervisor reviewing what came back from the first wave.",
    "Name only the angles that are still genuinely unanswered against the brief's",
    "criteria — a gap is something a reader would notice, not something that could",
    "merely be said at greater length.",
    "`angles` is an EMPTY list when the brief is covered; a second wave costs",
    "minutes and it should buy something.",
  ].join(" "),
  report: [
    "You write the final research report from the findings you are given.",
    "Markdown, with a `#` title and `##` sections that follow the brief's criteria.",
    "Be as comprehensive as the findings allow, and include everything relevant to",
    "the brief — a section should be as long as it needs to be to answer its part.",
    "Cite claims inline with the numbers in the Sources list you are given, e.g. [3],",
    "and end with a `## Sources` list of only the sources you cited, under the same",
    "numbers.",
    "Say plainly where the research came up short. Never invent a source, a number",
    "or a date, and never pad with commentary about the research process itself.",
  ].join(" "),
  summary: [
    "You reduce a research report to what a voice agent can say out loud.",
    "Two sentences at most. No markdown, no lists, no citation markers, no URLs.",
    "Lead with the answer, not with what was done. If the research was inconclusive,",
    "say that first and in those words.",
  ].join(" "),
};
