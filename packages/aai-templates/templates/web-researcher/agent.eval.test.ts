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
// `../code-interpreter/agent.eval.test.ts`.
import { deployedAgent } from "@alexkroman1/aai/testing";
import { describeEval } from "@alexkroman1/aai-runtime/eval/vitest";
import { expect } from "vitest";
import authored from "./agent.ts";
import systemPrompt from "./system-prompt.md?raw";

const agentDef = deployedAgent(authored, { systemPrompt: systemPrompt });

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
      // announcing one.
      const firstTool = turn.events.findIndex((e) => e.type === "tool.called");
      const firstSaid = turn.events.findIndex((e) => e.type === "agent-transcript.committed");
      expect(firstSaid).toBeGreaterThan(-1);
      expect(firstTool).toBeGreaterThan(-1);
      expect(firstTool).toBeLessThan(firstSaid);
    },
    { live: true },
  );

  test(
    "cites a site that appeared in its own results",
    async ({ session }) => {
      const turn = await session.say("Who is the current CEO of Boeing?");

      const labels = hostLabels(turn);
      expect(labels.length).toBeGreaterThan(0);
      // "Cite sources by website name" — and cite one you read. A reply that
      // names an outlet absent from the results is the fabrication this case
      // exists to catch, and it fails here exactly like a reply that cites
      // nothing at all.
      const spoken = turn.text.toLowerCase();
      expect(labels.filter((label) => spoken.includes(label))).not.toEqual([]);
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
