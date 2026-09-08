// Copyright 2026 the AAI authors. MIT license.
/**
 * What a research pass PASSES BETWEEN its stages, and how a later one reads it.
 *
 * A leaf: it imports nothing, which is the property that makes it useful.
 * `research.ts` composes the stages, `filing.ts` delivers what they produced,
 * and both need the same four shapes — so putting them in either would make the
 * other import a module for a type and pull its whole graph behind it. It is
 * also what keeps `research.ts` a file about the FLOW: a step's shape is not a
 * step.
 *
 * Everything here is pure and has no `ctx`, so a spec asserts it directly.
 */

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

/** The brief as the models are shown it. */
export function briefText(brief: Brief): string {
  const criteria = brief.criteria.map((one) => `- ${one}`).join("\n");
  return criteria
    ? `Brief: ${brief.brief}\n\nA complete answer covers:\n${criteria}`
    : `Brief: ${brief.brief}`;
}

/** One note, as a later stage reads it. */
export function noteText(note: Note): string {
  const cited = note.sources.map((one, at) => `[${at + 1}] ${one.title} — ${one.url}`).join("\n");
  return `## ${note.angle}\n${note.findings}\n${cited}`;
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
