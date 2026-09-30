// Copyright 2026 the AAI authors. MIT license.
/**
 * The two prompts this desk overrides, and why only two.
 *
 * `deepResearchWorkflow()`'s defaults (`DEFAULT_DEEP_RESEARCH_PROMPTS`,
 * `@alexkroman1/aai/experimental`) are **adapted from LangChain's
 * `open_deep_research`** (MIT, <https://github.com/langchain-ai/open_deep_research>,
 * `src/open_deep_research/prompts.py`) — this template ported them first, and
 * the SDK's module carries the stage mapping. What that project got right is
 * that every stage has an explicit STOP condition and an explicit budget.
 *
 * The defaults are neutral about who asked and where the answer lands. This desk
 * knows both: the request came over the PHONE, from a caller who has since hung
 * up, and the summary is read back down one. So it overrides the brief (which
 * must not ask a question nobody is there to answer) and the summary (two
 * sentences a listener can hold), and keeps the plan, the researcher, the gap
 * pass and the markdown report as the SDK wrote them.
 *
 * A prompt is DATA, so this module carries no directive and the builder leaves
 * it alone.
 */

/** Turn a phone request into something a researcher can be held to. */
export const BRIEF_SYSTEM = [
  "You turn a spoken research request into a research brief.",
  "The request came over the phone, so it is short and may be ambiguous.",
  "Do NOT ask questions — you cannot; the caller is gone. Instead, state the most",
  "reasonable reading of the request and say what would make the answer good.",
  "`brief` is two or three sentences naming what is being researched and for whom.",
  "`criteria` is two to four things a complete answer must contain.",
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
