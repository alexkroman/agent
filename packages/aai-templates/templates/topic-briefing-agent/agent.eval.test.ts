// An EVAL: does the desk really DELEGATE, or does it brief you from memory?
//
// `agent.test.ts` settles what each tool does once it has been called — it
// hands `researchAngle` a `stubDelegate` and asserts on the board. What it
// cannot settle is the two things this template exists to demonstrate: that the
// MODEL turns "tell me about home battery prices" into ONE `research_topic`
// call carrying several angles rather than one call per angle, and that nothing
// the caller hears came from a web tool the DESK holds — because it holds none.
//
// Run it with `aai eval`. Without a provider key every case runs against a
// SCRIPTED model (its `stubReply`), which proves the wiring and nothing about
// the choice — so the two claims above are `{ live: true }` and the recap case,
// whose whole point is that it spends no model at all, is not.
//
// `send_briefing` deliberately has no case here, and the reason is worth
// stating rather than leaving as an omission: the only way to measure it is to
// really post, and an eval that writes to a real Slack channel on every run is
// a test with a side effect nobody asked for. It is settled in `agent.test.ts`
// against `installStubStepFetch` instead; what an eval could add — that the
// desk offers it rather than reciting the briefing — is a judgement about
// phrasing, which is the kind of claim these evals stay away from.

import agentDef from "virtual:aai/agent";
import { countWords, isToolFailure } from "@alexkroman1/aai/utils";
import {
  describeEval,
  describeTurn,
  toolNames,
  toolResultIn,
} from "@alexkroman1/aai-runtime/testing/vitest";
import { expect } from "vitest";
import { z } from "zod";
import { MAX_ANGLES } from "./shared.ts";
import briefingSoFar from "./tools/briefing_so_far.ts";
import researchTopic from "./tools/research_topic.ts";
import verifyClaim from "./tools/verify_claim.ts";

/**
 * Every tool the desk declares — the two that reach the outside world through a
 * named subagent, the recap that reaches nothing, the one that posts the board
 * to Slack, and the roster's `delegate`.
 *
 * Named here because the isolation claim is stated as a NEGATIVE — no
 * `web_search`, no `visit_webpage` — and a negative over a hand-typed list is
 * the assertion that goes quietly true when a tool is renamed. Every call the
 * desk makes must be one of these four names.
 *
 * `delegate` is on the list rather than derived from `agent({ subagents })`,
 * for the same reason the other three are typed out: the point of the list is
 * to be a second, independent statement of what this agent may call.
 */
const DESK_TOOLS: readonly string[] = [
  "research_topic",
  "verify_claim",
  "briefing_so_far",
  "send_briefing",
  "delegate",
];

describeEval(agentDef, (test) => {
  test(
    "a recap on an empty board costs no researcher",
    async ({ session }) => {
      const turn = await session.say("What have you got for me so far?");

      // The one tool here that spends no model at all, and the case that can
      // therefore run against a script: the desk answers the recap out of its
      // own slot. A desk that reached for `research_topic` to find out what it
      // already knows is the regression — it bills the caller for four
      // researchers to answer "nothing yet".
      expect(toolNames(turn.toolCalls), describeTurn(turn)).toEqual(["briefing_so_far"]);
      // And the slot really resolved: an empty board reports itself as empty
      // rather than throwing or answering with a half-built shape.
      expect(toolResultIn(turn.toolCalls, briefingSoFar)).toMatchObject({
        topic: null,
        findings: [],
      });
    },
    {
      stubReply: [
        { tool: "briefing_so_far", args: {} },
        "Nothing yet — tell me a subject and I'll put some researchers on it.",
      ],
    },
  );

  test(
    "fans one subject out across angles in a SINGLE call",
    async ({ session }) => {
      const turn = await session.say("What's going on with home battery prices?");

      // One call carrying several angles, never one call per angle. That is the
      // whole economic claim of the template — the angles run in parallel, so
      // the caller waits for the slowest rather than the sum — and a desk that
      // called the tool three times in a row would satisfy any assertion that
      // merely counted angles.
      const calls = turn.toolCalls.filter((call) => call.name === "research_topic");
      expect(calls, describeTurn(turn)).toHaveLength(1);
      const angles = z.array(z.string()).parse(calls[0]?.args.angles);
      expect(angles.length).toBeGreaterThan(1);
      expect(angles.length).toBeLessThanOrEqual(MAX_ANGLES);
      // Each angle stands on its own — the prompt's rule, and the one a
      // researcher cannot recover from, having heard none of this call. A bare
      // "the same for Europe" is a handful of characters; a self-contained
      // question is a sentence.
      for (const angle of angles) expect(angle.length).toBeGreaterThan(15);

      // What came back is what the researchers concluded, not what the desk
      // believes: every finding carries prose, and the board holds the topic.
      const result = toolResultIn(turn.toolCalls, researchTopic);
      if (isToolFailure(result)) throw new Error(result.error);
      expect(result.findings).not.toEqual([]);
      for (const finding of result.findings) expect(finding.summary.length).toBeGreaterThan(40);

      // The isolation claim, and the reason this template is not
      // `web-research-agent`: the desk has NO web tools, so anything it says about
      // the world crossed back out of a subagent. A `web_search` in this list
      // would mean the builtins had leaked onto the parent.
      expect(toolNames(turn.toolCalls).filter((name) => !DESK_TOOLS.includes(name))).toEqual([]);
      expect(turn.text).not.toBe("");
    },
    // Live only: a script cannot choose the angles, and choosing them is the
    // measurement. It also cannot run a subagent — the researcher resolves a
    // model of its own from `shared.ts`, which the turn's stub never covers.
    { live: true },
  );

  test(
    "checks a claim the caller pushes back on instead of defending it",
    async ({ session }) => {
      const turn = await session.say(
        "Someone told me home batteries pay for themselves in two years. " +
          "Is that right? Check it for me.",
      );

      // `verify_claim` is the cheaper subagent on the narrower surface, and
      // reaching for it rather than answering is the prompt's rule that a live
      // model actually has to keep. The claim it forwards must be the sentence
      // it was given, not a keyword — a fact-checker handed "batteries" answers
      // confidently about nothing.
      const calls = turn.toolCalls.filter((call) => call.name === "verify_claim");
      expect(calls, describeTurn(turn)).toHaveLength(1);
      const verdict = toolResultIn(turn.toolCalls, verifyClaim);
      if (isToolFailure(verdict)) throw new Error(verdict.error);
      expect(countWords(verdict.claim)).toBeGreaterThan(3);
      // A word the desk can act on, not a sentence it must read one out of —
      // or the honest unresolved path, which is the SAME contract seen from the
      // other side. `factChecker` is a cheap model on `maxSteps: 2`, so a run
      // that spends both steps searching returns no schema and the tool reports
      // `unusable` rather than a verdict — which its own body argues is "not a
      // failure". Demanding a verdict every time made this case a coin toss on
      // that budget instead of a reading of whether the desk CHECKED rather
      // than defended, which is what its name claims and what the `toHaveLength`
      // above actually measures.
      if (verdict.verdict === null) {
        expect(verdict.unusable, describeTurn(turn)).toBeDefined();
      } else {
        expect(countWords(verdict.detail)).toBeGreaterThan(2);
      }
      expect(toolNames(turn.toolCalls).filter((name) => !DESK_TOOLS.includes(name))).toEqual([]);
    },
    { live: true },
  );
});
