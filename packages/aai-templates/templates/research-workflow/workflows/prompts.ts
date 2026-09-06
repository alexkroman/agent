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
 * | compress | {@link RESEARCH_OUTPUT} — findings kept verbatim, cited; the
 *   researcher's own `expectedOutput` rather than a second model call |
 * | final report | {@link REPORT_SYSTEM}, plus {@link BRIEF_SUMMARY_SYSTEM} for the phone |
 *
 * They are ADAPTED rather than copied: theirs are written for a LangGraph agent
 * returning a long markdown report to a reader, and ours end at a voice agent
 * reading two sentences down a phone. The RESEARCHER's is now closest to theirs
 * of all of them — it went back to describing a job rather than a JSON action
 * protocol when `stepDelegate` made the loop the runtime's (see
 * `workflows/research.ts`), which deleted the "reply as JSON, one action per
 * turn" contract that had been standing in for a tool call.
 *
 * What survives verbatim is the part that is the actual finding: the stop
 * rules, "repeat the useful text rather than summarizing it away", and citing
 * as you go rather than at the end.
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
 * The researcher's BRIEF — no longer its loop.
 *
 * The stop rules are the heart of the adaptation and are close to theirs,
 * because they are the finding: without them a researcher either stops at the
 * first plausible page or keeps searching until the budget runs out, and both
 * look identical in the output.
 *
 * What is gone is the half that was never about research — "reply as JSON, one
 * action per turn", plus "ALWAYS stop when the budget is spent". The runtime
 * owns both now: a tool call is how an action is named, and the last step is
 * spent with tools withheld so a capped run answers instead of stopping
 * mid-chain. A rule the framework enforces should not also be asked for.
 */
export const RESEARCH_SYSTEM = [
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
].join("\n");

/**
 * What a researcher's FINAL MESSAGE has to be — `SubagentDef.expectedOutput`.
 *
 * It was a second model call over everything the researcher had seen, and it is
 * the researcher's own answer now: a subagent's final message is the only thing
 * that crosses back, so the compression happens where the raw material already
 * is. One stage fewer, one prompt fewer, and no way for the two to disagree
 * about what a finding is.
 *
 * "Repeat the relevant text rather than summarizing it" is theirs and is
 * counter-intuitive enough to be worth keeping verbatim in spirit: a summary of
 * a summary is what makes a long research pass produce a confident, sourceless
 * paragraph at the end.
 */
export const RESEARCH_OUTPUT = [
  "Everything you found that bears on the angle, written out cleanly — repeat",
  "the relevant text rather than summarizing it away. A later stage does the",
  "summarizing and can only work with what you keep, so length is not the thing",
  "to economize on here.",
  "Mark each claim with the source you took it from. If you could not establish",
  "something, say so rather than guessing at it — including when the budget ran",
  "out before you were satisfied.",
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
