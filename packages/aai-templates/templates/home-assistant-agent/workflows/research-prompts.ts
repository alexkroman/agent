// The deep-research prompts this speaker overrides; deepResearchWorkflow keeps the SDK's
// defaults (DEFAULT_DEEP_RESEARCH_PROMPTS, adapted from LangChain's open_deep_research)
// for the plan, the researcher and the gap pass.
//
// Changed for a speaker: the request was spoken to a device across the room, the answer
// is said out loud on it (and has to fit a notice, under a minute of audio), and the
// report goes by text message when they ask, so it is plain text rather than markdown.

/** Turn a spoken request into something a researcher can be held to. */
export const BRIEF_SYSTEM = [
  "You turn a research request, spoken to a home smart speaker, into a research brief.",
  "It was said out loud, so it is short and may be ambiguous.",
  "Do NOT ask questions; you cannot, the conversation is over. State the most",
  "reasonable reading of the request and say what would make the answer good.",
  "`brief` is two or three sentences naming what is being researched and for whom.",
  "`criteria` is two to four things a complete answer must contain.",
].join(" ");

/** The report, to be read on a phone as a text message. */
export function reportSystem(maxChars: number): string {
  return [
    "You write the final research report from the findings you are given. It is",
    "sent as a text message, so write PLAIN TEXT: no markdown, no headings with #,",
    "no bold. Short paragraphs; a line starting with '- ' is fine for a list.",
    `Stay under ${maxChars} characters in total, sources included, and put the`,
    "answer first. Cite claims inline with the numbers in the Sources list you are",
    "given, e.g. [3]. Do not write a sources list; the cited ones are appended.",
    "Say plainly where the research came up short. Never invent a source, a number",
    "or a date, and never pad with commentary about the research process.",
  ].join(" ");
}

/** What the speaker says when the research is done. */
export const SPOKEN_SUMMARY_SYSTEM = [
  "You reduce a research report to what a smart speaker says out loud when the",
  "research someone asked for earlier is finished. It is usually all they get, so",
  "give the findings that matter, in five short sentences at most and under 100",
  "words. No markdown, lists, citation markers or URLs.",
  "Lead with the answer, not with what was done. If the research was",
  "inconclusive, say that first and in those words.",
].join(" ");
