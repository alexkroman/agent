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

/**
 * The def a DEPLOYED agent runs: authored, plus what `tools/` declares, plus
 * its PROMPT.
 *
 * Taken from `virtual:aai/agent` rather than a hand-written glob: the plugin
 * expands it against THIS file's own directory, so the spec needs no glob and
 * no shared helper — which matters because this file SHIPS, and a scaffolded
 * project has no repo helper to import. `agent.ts` here is three fields, so an
 * eval driving it alone would measure an agent with no tools and the FRAMEWORK
 * DEFAULT prompt — i.e. a desk that has never heard of a researcher, on which
 * every claim below would pass or fail for the wrong reason. The reasoning is
 * spelled out in `../code-interpreter/agent.eval.test.ts`.
 */
import agentDef from "virtual:aai/agent";
import { describeTurn, toolNames, toolResultIn } from "@alexkroman1/aai-runtime/eval";
import { describeEval } from "@alexkroman1/aai-runtime/eval/vitest";
import { expect } from "vitest";
import { z } from "zod";
import { MAX_ANGLES } from "./shared.ts";

/**
 * Every tool the desk declares — the two that reach the outside world through a
 * subagent, and the recap that reaches nothing.
 *
 * Named here because the isolation claim is stated as a NEGATIVE — no
 * `web_search`, no `visit_webpage` — and a negative over a hand-typed list is
 * the assertion that goes quietly true when a tool is renamed. Every call the
 * desk makes must be one of these three names.
 */
const DESK_TOOLS: readonly string[] = ["research_topic", "verify_claim", "briefing_so_far"];

/**
 * What `research_topic` answers with, as a schema rather than a cast.
 *
 * `toolResultIn` takes one for the reason `night-owl`'s spec records: a result
 * that stopped carrying `findings` FAILS here naming the field, where a cast
 * hands the assertions `undefined` and fails a line later on something
 * unrelated.
 */
const BriefingResult = z.object({
  topic: z.string(),
  findings: z.array(z.object({ angle: z.string(), summary: z.string() })),
  failed: z.array(z.object({ angle: z.string() })),
});

/** What `briefing_so_far` answers with on an EMPTY board. */
const EmptyRecap = z.object({
  topic: z.null(),
  findings: z.array(z.unknown()).length(0),
  message: z.string(),
});

/** What `verify_claim` answers with. */
const Verdict = z.object({ claim: z.string(), verdict: z.string() });

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
      expect(toolResultIn(turn.toolCalls, "briefing_so_far", EmptyRecap).topic).toBeNull();
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
      const result = toolResultIn(turn.toolCalls, "research_topic", BriefingResult);
      expect(result.findings).not.toEqual([]);
      for (const finding of result.findings) expect(finding.summary.length).toBeGreaterThan(40);

      // The isolation claim, and the reason this template is not
      // `web-researcher`: the desk has NO web tools, so anything it says about
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
      const verdict = toolResultIn(turn.toolCalls, "verify_claim", Verdict);
      expect(verdict.claim.split(/\s+/).length).toBeGreaterThan(3);
      expect(verdict.verdict).not.toBe("");
      expect(toolNames(turn.toolCalls).filter((name) => !DESK_TOOLS.includes(name))).toEqual([]);
    },
    { live: true },
  );
});
