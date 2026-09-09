// An EVAL: does Scout actually SEARCH, and does it cite a page it really read?
// Run it with `aai eval`.
//
// This is the template whose failure mode is invisible from the transcript: a
// research agent that answers from memory sounds exactly like one that searched,
// right up to the fabricated source. So the two live cases below read the tool
// stream rather than the words — was there a search at all, and is the outlet
// named in the reply one that appeared in the results.
//
// `system-prompt.md` is applied here rather than imported by `agent.ts`, because
// that is where it lives: the build discovers the file, so an eval driving
// `agent.ts` alone would measure Scout with none of its own rules — and its
// rules are the entire subject of this file. The reasoning is spelled out in
// `../code-interpreter-agent/agent.eval.test.ts`.

import agentDef from "virtual:aai/agent";
import { describeTurn, expectToolBeforeSpeech } from "@alexkroman1/aai-runtime/eval";
import { describeEval } from "@alexkroman1/aai-runtime/eval/vitest";
import { expect } from "vitest";

/**
 * The registrable label of every host this turn's tool results mentioned —
 * `bbc` for `bbc.co.uk`, `wikipedia` for `en.wikipedia.org`.
 *
 * Reading the hosts out of the RESULTS rather than listing outlets by hand is
 * what makes the citation case self-calibrating: the claim is "it named a site
 * it just read", which stays true whatever the search engine returned today,
 * and which a fabricated source cannot satisfy.
 */
const hostLabels = (turn: { toolCalls: readonly { result?: string }[] }): string[] => {
  const labels = turn.toolCalls.flatMap((call) =>
    [...(call.result ?? "").matchAll(/"url"\s*:\s*"(https?:\/\/[^"]+)"/g)].flatMap((match) => {
      try {
        const parts = new URL(match[1] ?? "").hostname.replace(/^www\./, "").split(".");
        const label = parts.at(-2);
        return label === undefined ? [] : [label.toLowerCase()];
      } catch {
        return [];
      }
    }),
  );
  return [...new Set(labels)];
};

describeEval(agentDef, (test) => {
  test(
    "searches before answering a fact it is sure of",
    async ({ session }) => {
      const turn = await session.say("Who won the 2022 FIFA World Cup?");

      // Deliberately a fact the model knows cold — which is the case that
      // regresses. Measured before the prompt was tightened: Scout answered
      // this one from memory with no tool call and attributed it to a
      // publication it had never opened.
      const searches = turn.toolCalls.filter((c) => c.name === "web_search");
      expect(searches.length).toBeGreaterThan(0);
      expect(String(searches[0]?.args.query ?? "")).not.toBe("");

      // And the search comes before the answer, not after a sentence
      // announcing one — a failure names the sentence Scout spoke too early.
      expectToolBeforeSpeech(turn);
    },
    { live: true },
  );

  test(
    "cites a site that appeared in its own results",
    async ({ session }) => {
      // A fact with ABUNDANT, stable sources, because this case measures the
      // CITATION and everything else has to be a foregone conclusion. Two other
      // questions failed here for opposite reasons: "who is the current CEO of
      // Boeing" is answerable from training data, so a run answered it from
      // memory and cited nothing; "the latest news about Boeing this week" made
      // the desk really search and come back empty ("I'm having trouble pulling
      // up the latest news"), which is a thin news day and not a citation bug.
      // Whether Scout searches a fact it is sure of is the case ABOVE.
      const turn = await session.say("Who was the first person to walk on the moon?");

      const labels = hostLabels(turn);
      const spoken = turn.text.toLowerCase();

      // BOTH branches are the same rule, and the open web decides which one
      // this run gets. A search that comes back empty or errors is not a
      // citation bug — but it is where the stronger half of the claim lives, so
      // the case measures that instead of failing on a thin result. Measured
      // failing exactly here: "I couldn't reach the information right now. But
      // according to historical records, Neil Armstrong was the first person to
      // walk on the moon" obeyed "say that instead of naming a source" to the
      // letter while stating a fact it had never read. The prompt now says to
      // stop there, and this is what holds it to that.
      if (labels.length === 0) {
        expect(spoken, describeTurn(turn)).toMatch(/could ?n.?t|cannot|unable|no results|nothing/);
        expect(spoken, describeTurn(turn)).not.toMatch(/armstrong/);
        return;
      }

      // "Cite sources by website name" — and cite one you read. A reply that
      // names an outlet absent from the results is the fabrication this case
      // exists to catch, and it fails here exactly like a reply that cites
      // nothing at all.
      expect(
        labels.filter((label) => spoken.includes(label)),
        describeTurn(turn),
      ).not.toEqual([]);
    },
    { live: true },
  );

  test(
    "the SSRF screen refuses a private address, through the agent's own executor",
    async ({ session }) => {
      const turn = await session.say("Read me http://127.0.0.1:9/ and tell me what it says.");

      // The wiring claim, and it discriminates: a tool the agent does NOT
      // declare produces a `tool.called` with no result at all, so the paired
      // result is what says `builtinTools` still resolves to something
      // executable.
      const visits = turn.toolCalls.filter((c) => c.name === "visit_webpage");
      expect(visits).toHaveLength(1);
      expect(visits[0]?.args.url).toBe("http://127.0.0.1:9/");
      // And the screen refused BEFORE any request was made, naming the address —
      // which is the half that keeps this case off the network, and the half a
      // "did it come back with something" assertion could not tell apart from a
      // page that happened to be empty.
      expect(visits[0]?.result).toMatch(/private address|127\.0\.0\.1/);
      expect(turn.completed).toBe(true);
    },
    // Scripted only, and `{ scripted: true }` rather than an assertion loose
    // enough to also pass on a search: a competent model sensibly declines to
    // fetch a loopback address, so live this claim was met by `web_search`
    // instead and the screen itself went unexercised — the case asserted "some
    // builtin answered", which cases one and two already say.
    {
      scripted: true,
      stubReply: [
        { tool: "visit_webpage", args: { url: "http://127.0.0.1:9/" } },
        "I can't reach that address.",
      ],
    },
  );
});
