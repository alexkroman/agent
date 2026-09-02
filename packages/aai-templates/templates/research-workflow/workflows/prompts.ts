// Copyright 2026 the AAI authors. MIT license.
/**
 * The prompts the deep-research pass runs on, and where they come from.
 *
 * **Adapted from LangChain's `open_deep_research`** (MIT,
 * <https://github.com/langchain-ai/open_deep_research>, `src/open_deep_research/
 * prompts.py`) — the shape is theirs and it is the reason this template stopped
 * being three model calls in a row. What that project got right, and what a
 * naive research pipeline gets wrong, is that every stage has an explicit STOP
 * condition and an explicit budget: a researcher told "search until you know
 * enough" either stops at the first plausible page or never stops at all.
 *
 * The five stages it names map onto steps almost exactly, which is the other
 * reason to take the shape rather than invent one — a supervisor delegating to
 * researchers IS a fan-out, and a "compress" stage IS the thing that keeps a
 * step's journaled result small:
 *
 * | open_deep_research | here |
 * | --- | --- |
 * | research brief | {@link BRIEF_SYSTEM} — one call, before anything is searched |
 * | lead researcher / supervisor | {@link PLAN_SYSTEM}, then {@link GAPS_SYSTEM} for the second wave |
 * | researcher | {@link RESEARCH_SYSTEM} — the search loop, bounded |
 * | compress | {@link COMPRESS_SYSTEM} — findings kept verbatim, cited |
 * | final report | {@link REPORT_SYSTEM}, plus {@link BRIEF_SUMMARY_SYSTEM} for the phone |
 *
 * They are ADAPTED rather than copied: theirs are written for a LangGraph agent
 * that calls tools by name and returns a long markdown report to a reader, and
 * ours are written for a step that calls `webSearch` itself,
 * returns JSON a later step consumes, and ends at a voice agent reading two
 * sentences down a phone. What survives verbatim is the part that is the actual
 * finding: the numbered stop rules, "repeat the useful text rather than
 * summarizing it away", and citing as you go rather than at the end.
 *
 * A prompt is DATA, so this module carries no directive and the builder leaves
 * it alone — the same reason `transcription-workflow`'s `wav.ts` can sit beside its
 * bodies.
 */

/** Turn a phone request into something a researcher can be held to. */
export const BRIEF_SYSTEM = [
  "You turn a spoken research request into a research brief.",
  "The request came over the phone, so it is short and may be ambiguous.",
  "Do NOT ask questions — you cannot; the caller is gone. Instead, state the most",
  "reasonable reading of the request and say what would make the answer good.",
  'Reply as JSON: {"brief": string, "criteria": string[]}.',
  "`brief` is two or three sentences naming what is being researched and for whom.",
  "`criteria` is two to four things a complete answer must contain.",
].join(" ");

/** Decompose the brief into research units — the fan-out's width. */
export const PLAN_SYSTEM = [
  "You are a research supervisor. Break a research brief into independent angles,",
  "each of which one researcher can investigate on its own.",
  "Bias towards FEWER angles: use one when the brief is a single question, and",
  "only add angles where a genuinely separate line of enquiry exists. Two",
  "researchers covering the same ground is the failure to avoid.",
  "Each angle is one short noun phrase, specific enough to search for.",
  'Reply as JSON: {"angles": string[]}.',
].join(" ");

/**
 * The researcher's loop.
 *
 * The numbered stop rules are the heart of the adaptation and are close to
 * theirs, because they are the finding: without them a researcher either stops
 * at the first plausible page or keeps searching until the budget runs out, and
 * both look identical in the output.
 */
export const RESEARCH_SYSTEM = [
  "You are a researcher working on one angle of a research brief.",
  "You decide, one step at a time, what to do next: search the web, read a page",
  "you have already found, or stop because you have enough.",
  "",
  "Rules for how hard to look:",
  "- A simple, factual angle deserves 2 to 3 searches. A comparative or",
  "  contested one deserves up to the budget you are given.",
  "- STOP as soon as one of these is true: you can answer the angle thoroughly;",
  "  you have three or more relevant sources agreeing; the last two searches",
  "  returned much the same thing.",
  "- ALWAYS stop when the budget is spent, even if you are not satisfied. Say",
  "  what you did not manage to establish rather than guessing at it.",
  "- Prefer READING a promising result over running another search. A page you",
  "  have opened is worth more than a fourth list of titles.",
  "",
  'Reply as JSON, one action per turn: {"action": "search", "query": string} or',
  '{"action": "read", "url": string} or {"action": "stop", "why": string}.',
].join("\n");

/**
 * Compression, and the one instruction it turns on.
 *
 * "Repeat the relevant text rather than summarizing it" is theirs and is
 * counter-intuitive enough to be worth keeping verbatim in spirit: a summary of
 * a summary is what makes a long research pass produce a confident, sourceless
 * paragraph at the end.
 */
export const COMPRESS_SYSTEM = [
  "You are compressing one researcher's raw findings for a later stage.",
  "Keep ALL of the information that bears on the angle, rewritten cleanly —",
  "repeat the relevant text rather than summarizing it away. A later stage will",
  "do the summarizing, and it can only work with what you keep.",
  "Cite as you go: mark each claim with the number of the source it came from.",
  'Reply as JSON: {"findings": string, "sources": {"title": string, "url": string}[]}.',
  "The numbers you cite are 1-based indexes into `sources`.",
].join(" ");

/** The supervisor's second look: what is still unanswered. */
export const GAPS_SYSTEM = [
  "You are a research supervisor reviewing what came back from the first wave.",
  "Name only the angles that are still genuinely unanswered against the brief's",
  "criteria — a gap is something a reader would notice, not something that could",
  "merely be said at greater length.",
  "Answer with an EMPTY list when the brief is covered; a second wave costs the",
  "caller minutes and it should buy something.",
  'Reply as JSON: {"angles": string[]}.',
].join(" ");

/** The written report — what a page renders and what is filed. */
export const REPORT_SYSTEM = [
  "You write the final research report from the compressed findings you are given.",
  "Markdown, with a `#` title and `##` sections that follow the brief's criteria.",
  "Be as comprehensive as the findings allow, and include everything relevant to",
  "the brief — a section should be as long as it needs to be to answer its part.",
  "Keep the inline citations, renumbered sequentially with no gaps, and end with",
  "a `## Sources` list numbered to match.",
  "Say plainly where the research came up short. Never invent a source, a number",
  "or a date, and never pad with commentary about the research process itself.",
].join(" ");

/**
 * The voice-sized answer.
 *
 * The stage `open_deep_research` has no equivalent of, because its output is
 * read on a screen. This one is read down a phone by an agent that has already
 * said "I'll let you know", so the report is the wrong artefact entirely: two
 * sentences, no markdown, and nothing a listener cannot hold in their head.
 */
export const BRIEF_SUMMARY_SYSTEM = [
  "You reduce a research report to what an agent can say out loud on a phone call.",
  "Two sentences at most. No markdown, no lists, no citation markers, no URLs.",
  "Lead with the answer, not with what was done. If the research was inconclusive,",
  "say that first and in those words.",
].join(" ");
