/**
 * The desk's two subagents, and the board of what they have found.
 *
 * **This template is the worked example for `ctx.delegate`.** Everything here
 * exists to show the three things a subagent buys that `ctx.generate` cannot:
 *
 * 1. **A context window the caller never pays for.** `researcher` reads whole
 *    web pages. A briefing on four angles can spend a hundred thousand tokens
 *    doing it, and what comes back into the phone call's conversation is four
 *    paragraphs — because {@link DelegateResult.text} is the subagent's final
 *    message and nothing else crosses back.
 * 2. **Parallelism.** Four angles are four independent runs, so
 *    `tools/research_topic.ts` fans them out with one `Promise.allSettled` and
 *    the caller waits for the slowest, not for the sum.
 * 3. **Tools isolated by capability.** `researcher` can read the open web;
 *    `factChecker` can only search it, on a cheaper model with a third of the
 *    budget. Neither can reach the other's tools, and the DESK — the voice
 *    agent the caller is talking to — has no web tools at all.
 */

import {
  type DeepReadonly,
  type DelegateFn,
  type DelegateOptions,
  type DelegateResult,
  pushCapped,
  type SubagentToolCall,
  sessionSlot,
  subagent,
} from "@alexkroman1/aai";
import { assemblyAILlm } from "@alexkroman1/aai/llm";

/**
 * Steps one angle may take. A budget, not a limit to be raised when an answer
 * disappoints: a subagent told to "keep looking until sure" is a subagent whose
 * cost nobody can quote, and the caller is on the phone. Past it the researcher
 * is asked for its answer with its tools withheld, so a capped run still comes
 * back with prose rather than stopping mid-chain.
 */
export const MAX_RESEARCH_STEPS = 6;

/**
 * The researcher, and the one line that decides whether any of this works.
 *
 * "Finish with a summary" is not politeness. The parent gets the subagent's
 * FINAL message, so a run that ends by saying "Done." has thrown away
 * everything it read and no budget recovers it — this is the failure mode the
 * `SubagentDef.instructions` contract warns about, stated once, here.
 */
export const researcher = subagent({
  name: "researcher",
  instructions: [
    "You are a research agent working one angle of a briefing.",
    "",
    "Search, then open the two or three most promising pages and read them.",
    "Prefer primary sources and recent ones. If the sources disagree, say so",
    "rather than picking a side.",
    "",
    "IMPORTANT: your FINAL message is the only thing the desk receives — it",
    "does not see your searches, the pages you opened, or your reasoning. End",
    "with a self-contained paragraph of what you found, naming the sources you",
    "trusted. Three sentences is plenty; do not write a report.",
  ].join("\n"),
  // Read/browse. Independent of the desk's own builtins, which are none: the
  // agent the caller talks to never touches the network.
  builtinTools: ["web_search", "visit_webpage"],
  maxSteps: MAX_RESEARCH_STEPS,
});

/**
 * The fact-checker: a second ROLE, deliberately narrower than the first.
 *
 * Its own `llm` (cheaper and quicker — checking one sentence is not the job
 * `researcher` does), its own budget, and search only. That split is the third
 * reason to reach for a subagent: a capability a run does not need is one it
 * cannot misuse.
 */
export const factChecker = subagent({
  name: "fact-checker",
  instructions: [
    "You check ONE claim against what you can find on the web.",
    "",
    "Search for it. Answer in one sentence, starting with one of",
    "'Confirmed:', 'Contradicted:' or 'Unclear:', and name what you found.",
    "'Unclear' is a real answer — say it rather than guessing.",
  ].join("\n"),
  llm: assemblyAILlm({ model: "gemini-2.5-flash-lite" }),
  builtinTools: ["web_search"],
  maxSteps: 2,
});

/** One angle, as the desk holds it. */
export interface Finding {
  /** The angle the researcher was given. */
  angle: string;
  /** Its final message — the whole of what crossed back. */
  summary: string;
  /** Searches it ran and pages it opened, for narrating the wait. */
  work: AngleWork;
}

/** What one angle COST, as the desk is willing to say it out loud. */
export interface AngleWork {
  searches: number;
  reads: number;
}

/**
 * The brief one angle is sent with.
 *
 * Its own function because the `context` line is the whole of what a
 * researcher learns about the call it belongs to — a subagent's context is
 * ISOLATED, so anything the conversation knows and the angle does not say is
 * lost unless it is written here. A spec asserts on this rather than on a
 * template literal buried in a tool body.
 */
export function angleBrief(topic: string, angle: string): DelegateOptions {
  return { task: angle, context: `This angle belongs to a briefing on: ${topic}.` };
}

/**
 * What a run did, read off the calls it made.
 *
 * {@link DelegateResult.toolCalls} carries the CALLS and not their results —
 * the results are what stayed in the subagent's window — so this is the most
 * the desk can honestly say about the wait. An unrecognised tool name counts
 * as neither: a researcher that gains a third tool should not silently inflate
 * "searches".
 */
export function countWork(toolCalls: readonly SubagentToolCall[]): AngleWork {
  let searches = 0;
  let reads = 0;
  for (const call of toolCalls) {
    if (call.name === "web_search") searches += 1;
    else if (call.name === "visit_webpage") reads += 1;
  }
  return { searches, reads };
}

/**
 * Run one angle and reduce it to what the board holds.
 *
 * Takes the DELEGATE rather than the whole tool context — the same seam
 * `plan-and-execute` puts on `ctx.generate`. The desk's own logic is then
 * exercised against a fake without a context at all, and the tool that fans
 * these out stays one line per angle.
 */
export async function researchAngle(
  delegate: DelegateFn,
  topic: string,
  angle: string,
): Promise<Finding> {
  const result: DelegateResult = await delegate(researcher, angleBrief(topic, angle));
  return { angle, summary: result.text, work: countWork(result.toolCalls) };
}

/** Angles one `research_topic` call may fan out. Four researchers at once is
 *  already four model bills; past that a caller is waiting on a queue. */
export const MAX_ANGLES = 4;

/** Findings the board holds. Older ones fall off — they ride in every prompt
 *  the desk builds and in every recap it reads back. */
export const MAX_FINDINGS = 12;

export interface BriefingState {
  /** What the caller asked about, as last stated. */
  topic: string | null;
  /** Every angle researched on this call, oldest first. */
  findings: Finding[];
}

export function emptyBriefing(): BriefingState {
  return { topic: null, findings: [] };
}

export const briefingSlot = sessionSlot("briefing", emptyBriefing);

/** Record a finding, holding {@link MAX_FINDINGS}. */
export function recordFinding(state: BriefingState, finding: Finding): void {
  pushCapped(state.findings, finding, MAX_FINDINGS);
}

/**
 * The board as a READ hands it out — deep-frozen, and typed to say so, which is
 * what a slot's read returns.
 */
export type FrozenBriefing = DeepReadonly<BriefingState>;

/** A finding named by what the caller would say: its angle, loosely matched. */
export function findByAngle(
  state: FrozenBriefing,
  angle: string,
): DeepReadonly<Finding> | undefined {
  const wanted = angle.trim().toLowerCase();
  if (wanted === "") return undefined;
  return state.findings.find(
    (finding) =>
      finding.angle.toLowerCase().includes(wanted) || wanted.includes(finding.angle.toLowerCase()),
  );
}
