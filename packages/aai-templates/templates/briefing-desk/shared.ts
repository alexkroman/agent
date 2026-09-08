/**
 * The desk's subagents, and the board of what they have found.
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
 *
 * **And it is the worked example for the two ways to CHOOSE one**, which is the
 * split to read this file for:
 *
 * - `researcher` and `factChecker` are chosen in CODE, by the tool that names
 *   them. `research_topic` runs ONE subagent N times in parallel and
 *   `verify_claim` reads the board to turn "the second thing you told me" into
 *   a sentence — neither is a choice a model could make, and neither is a shape
 *   a roster can express.
 * - `explainer` and `counterpoint` are on the ROSTER (`agent({ subagents })`),
 *   because choosing between them IS reading what the caller asked: "what does
 *   curtailment mean" and "who says otherwise" want different specialists and
 *   nothing else about them differs. They reach the model as one `delegate`
 *   tool whose `coworker` argument is the two names, described by their own
 *   {@link SubagentDef.description}s.
 *
 * The rule that follows: **name a subagent in code when the tool IS the choice;
 * put it on the roster when the caller's words are.** An agent that grew a
 * fourth `tools/ask_the_<x>.ts` whose body was one `ctx.delegate` line has been
 * hand-rolling the roster.
 */

import {
  type DeepReadonly,
  type DelegateFn,
  type DelegateOptions,
  type DelegateResult,
  resolveOne,
  type SubagentRoster,
  type SubagentToolCall,
  sessionSlot,
  subagent,
  type ToolFailure,
  toolFailure,
} from "@alexkroman1/aai";
import { assemblyAILlm } from "@alexkroman1/aai/llm";
import { z } from "zod";

/**
 * Steps one angle may take. A budget, not a limit to be raised when an answer
 * disappoints: a subagent told to "keep looking until sure" is a subagent whose
 * cost nobody can quote, and the caller is on the phone. Past it the researcher
 * is asked for its answer with its tools withheld, so a capped run still comes
 * back with prose rather than stopping mid-chain.
 */
export const MAX_RESEARCH_STEPS = 6;

/**
 * The researcher, and the field that decides whether any of this works.
 *
 * `expectedOutput` is not politeness. The parent gets the subagent's FINAL
 * message, so a run that ends by saying "Done." has thrown away everything it
 * read and no budget recovers it. That used to be a paragraph of `systemPrompt`
 * every author had to remember to write; declaring it is what makes the runtime
 * responsible for putting it in front of the model instead.
 */
export const researcher = subagent({
  name: "researcher",
  systemPrompt: [
    "You are a research agent working one angle of a briefing.",
    "",
    "Search, then open the two or three most promising pages and read them.",
    "Prefer primary sources and recent ones. If the sources disagree, say so",
    "rather than picking a side.",
  ].join("\n"),
  expectedOutput: [
    "A self-contained paragraph of what you found, naming the sources you",
    "trusted. Three sentences is plenty; do not write a report. The desk does",
    "not see your searches, the pages you opened, or your reasoning — only this.",
  ].join("\n"),
  // Read/browse. Independent of the desk's own builtins, which are none: the
  // agent the caller talks to never touches the network.
  builtinTools: ["web_search", "visit_webpage"],
  maxSteps: MAX_RESEARCH_STEPS,
});

/**
 * The three verdicts a check may come back with — see {@link factChecker}.
 *
 * A SCHEMA rather than a sentence prefix. The desk branches on which of the
 * three it is (`tools/verify_claim.ts` tells it to correct itself on
 * `contradicted`), so this is a value the caller reads, not prose it forwards —
 * and a value the caller reads is what `SubagentDef.schema` is for.
 */
export const VerdictSchema = z.object({
  verdict: z.enum(["confirmed", "contradicted", "unclear"]),
  /** One sentence of what was found, in the checker's own words. */
  detail: z.string().min(1),
});

export type Verdict = z.infer<typeof VerdictSchema>;

/**
 * The fact-checker: a second ROLE, deliberately narrower than the first.
 *
 * Its own `llm` (cheaper and quicker — checking one sentence is not the job
 * `researcher` does), its own budget, and search only. That split is the third
 * reason to reach for a subagent: a capability a run does not need is one it
 * cannot misuse.
 *
 * **And it is the worked example for `SubagentDef.schema`.** The verdict is not
 * a style preference — `tools/verify_claim.ts` tells the desk to CORRECT itself
 * when a claim comes back contradicted, and the desk can only act on that if it
 * can READ which of the three it is. This used to be an English sentence prefix
 * (`"Confirmed:"`), restated in `expectedOutput` and re-checked by a
 * `guardrail` doing `startsWith` — three layers carrying one enum, and a model
 * that wrote `"Confirmed - "` was wrong in a way only prose could describe.
 * The schema makes it a parse, and the runtime sends a mis-shaped answer back
 * on the same retry budget the guardrail used.
 *
 * The `guardrail` is gone with it, and that is the split worth remembering: a
 * guardrail is for the judgement a shape cannot express — a missing citation,
 * sources that are all one publisher — and this was never that.
 */
export const factChecker = subagent({
  name: "fact-checker",
  systemPrompt: [
    "You check ONE claim against what you can find on the web.",
    "",
    "Search for it. 'Unclear' is a real answer — say it rather than guessing.",
  ].join("\n"),
  // The SHAPE comes from `schema`; what stays here is what a schema cannot say —
  // that `detail` is one sentence and names the evidence.
  expectedOutput: "`detail` is one sentence naming what you found and where.",
  schema: VerdictSchema,
  llm: assemblyAILlm({ model: "gemini-2.5-flash-lite" }),
  builtinTools: ["web_search"],
  maxSteps: 2,
});

/**
 * The ROSTER's first specialist: what a word means.
 *
 * No tools at all, which is legal and is the point — a definition is a
 * reasoning pass, and giving this one a search would let it wander off into
 * researching the thing rather than explaining it.
 *
 * The `description` is what the model reads when it picks; the `systemPrompt`
 * is what this subagent reads once it has been picked. Keeping them apart is
 * the difference between a roster the model can route and a list of names.
 */
export const explainer = subagent({
  name: "explainer",
  description: "Explains a term, unit or concept in plain language, from general knowledge",
  systemPrompt: [
    "You explain one thing to someone who is LISTENING, not reading, and who",
    "asked because they did not want to look it up.",
    "",
    "Use no jargon to explain jargon. If a number makes it concrete, give one.",
    "If you are not sure what the term means in this context, say so — a wrong",
    "definition is worse than an admitted gap.",
  ].join("\n"),
  expectedOutput: "Two sentences, spoken plainly. No preamble and no list.",
  llm: assemblyAILlm({ model: "gemini-2.5-flash-lite" }),
  maxSteps: 1,
});

/**
 * The roster's second: who argues the other way.
 *
 * Searches, like the fact-checker, and is told to do a different job with the
 * results — which is exactly the case a roster is for. Nothing about
 * `counterpoint` differs from `explainer` except what the caller wanted, so a
 * tool file per specialist would be two bodies differing in one identifier.
 */
export const counterpoint = subagent({
  name: "counterpoint",
  description: "Finds the strongest argument AGAINST something the desk has said",
  systemPrompt: [
    "You are given a claim and you look for the best case against it.",
    "",
    "Search for the objection, not for the claim. Report the strongest version",
    "you find, and say who makes it. If the objection is weak or fringe, say",
    "that plainly rather than inflating it — the caller is deciding something.",
  ].join("\n"),
  expectedOutput:
    "Two or three sentences: the objection, who makes it, and how seriously to take it.",
  llm: assemblyAILlm({ model: "gemini-2.5-flash-lite" }),
  builtinTools: ["web_search"],
  maxSteps: 3,
});

/**
 * The roster `agent({ subagents })` publishes — the specialists the MODEL picks
 * between.
 *
 * Declared here rather than inline in `agent.ts` so that membership sits beside
 * the definitions, which is where the question "should this one be routable?"
 * gets answered. `researcher` and `factChecker` are deliberately absent: each is
 * reached by a tool that does real work around the delegation, and a specialist
 * reachable both ways gives the model a second, worse route to it.
 */
export const roster: SubagentRoster = [explainer, counterpoint];

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

export const briefingSlot = sessionSlot("briefing", emptyBriefing, {
  // Held by the slot rather than by a `recordFinding` wrapper, so a tool that
  // pushes to the board directly is bounded too.
  caps: { findings: MAX_FINDINGS },
});

/**
 * The board as a READ hands it out — deep-frozen, and typed to say so, which is
 * what a slot's read returns.
 */
export type FrozenBriefing = DeepReadonly<BriefingState>;

/**
 * A finding named by what the caller would say: its angle, loosely matched.
 *
 * `resolveOne`'s, and this is the one place on the board where that contract is
 * the right one. Every other lookup in this template — and in almost every
 * template — is an exact id the model already chose off a list, where "no such
 * id" is the whole answer. Here the argument is the caller's OWN WORDS about
 * something already on the board, so two findings can match one phrase.
 *
 * What it replaces guessed. The `.find()` here took the FIRST angle whose text
 * overlapped the phrase in either direction, so "lead times" quietly picked one
 * of "install lead times" and "battery lead times" by board order — and
 * answered `undefined` for both "nothing matches" and "several do", which is
 * the distinction the caller needs. It now returns a `ToolFailure` LISTING the
 * candidates, so the desk asks which one instead of fact-checking against the
 * wrong context.
 *
 * The scorer is the overlap that was inline before, scored rather than
 * booleaned: a longer shared prefix of words wins, and a tie FAILS.
 */
export function findByAngle(
  state: FrozenBriefing,
  angle: string,
): DeepReadonly<Finding> | ToolFailure {
  const wanted = angle.trim().toLowerCase();
  if (wanted === "") return toolFailure("Say which angle on the board this claim came from.");
  return resolveOne(state.findings, wanted, {
    label: "angle",
    describe: (finding) => finding.angle,
    // Word overlap in either direction, which is what the substring test was
    // approximating — counted, so "install lead times" beats "lead times" for
    // the phrase "install lead times" instead of both merely being true.
    score: (finding, text) => {
      const words = finding.angle.toLowerCase().split(/\s+/).filter(Boolean);
      return words.filter((word) => text.includes(word)).length;
    },
  });
}
