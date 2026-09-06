// An EVAL: does Penny fetch the rate, compute the split, and refuse to hand out
// investment advice? Run it with `aai eval`.
//
// Penny has two builtins and a rule about what she may not say, so the three
// live cases below are one per promise the prompt makes: fetch_json for
// anything that moves (rates, crypto), run_code for anything arithmetic, and a
// not-financial-advice caveat whenever the subject is an investment.
//
// The two harness facts, argued at length in
// `../code-interpreter/agent.eval.test.ts`: `system-prompt.md` is discovered by
// the build rather than imported, so an eval has to apply it or it measures an
// agent with no house rules at all; and `run_code` refuses unless the EVAL
// supplies an executor, which this suite does — so the arithmetic cases assert
// the answer as well as the code that was submitted. `fetch_json` is
// unaffected — it makes a real request, so the currency case really does reach a
// live rates API.

import agentDef from "virtual:aai/agent";
import {
  createVmRunCode,
  describeTurn,
  type EvalTurn,
  runCodeIn,
  runCodeOutput,
  toolArgsIn,
  toolNames,
} from "@alexkroman1/aai-runtime/eval";
import { describeEval } from "@alexkroman1/aai-runtime/eval/vitest";
import { expect } from "vitest";
import { z } from "zod";

/**
 * The arguments Penny's `fetch_json` calls carry, as the wire has them.
 *
 * A schema rather than `String(args.url ?? "")`, which is what `toolArgsIn`
 * takes one for: `args` is `Record<string, unknown>` — the model wrote it and
 * nothing validated it — so a URL Penny renamed, or never sent, used to read as
 * `""`, and the claim below about the endpoint she asked for would have been a
 * claim about an empty string. An argument that stops arriving FAILS here,
 * naming the field. (`run_code`'s arguments go through `runCodeIn`, which is
 * this same reader with the builtin's own schema already supplied.)
 */
const FetchJsonArgs = z.object({ url: z.string() });

/** Every URL this turn's `fetch_json` calls asked for. */
const fetchedUrls = (turn: EvalTurn) =>
  toolArgsIn(turn.toolCalls, "fetch_json", FetchJsonArgs).map((args) => args.url);

describeEval(
  agentDef,
  (test) => {
    test(
      "splits a bill in code, tip included",
      async ({ session }) => {
        const turn = await session.say(
          "Help me split a 120 dollar bill four ways with a 20 percent tip.",
        );

        // Three numbers, two operations and a rounding rule: the exact shape of
        // question a model answers plausibly and wrongly. All three inputs have
        // to reach the code, or something was worked out in the model's head.
        expect(toolNames(turn.toolCalls), describeTurn(turn)).toContain("run_code");
        const code = runCodeIn(turn.toolCalls);
        expect(code).toContain("120");
        expect(code).toMatch(/\b4\b/);
        expect(code).toMatch(/20|0\.2/);

        // And the sum came out right: $120 plus 20% is $144, four ways is $36.
        // Without an executor `run_code` answers with a refusal, so every claim
        // above is satisfied by an agent that then divides in its head — which is
        // the failure this template's whole run_code rule exists to prevent.
        // `runCodeOutput` throws on that refusal rather than handing it back.
        const output = runCodeOutput(turn.toolCalls);
        expect(output, `run_code printed: ${output}`).toMatch(/\b36(\.0+)?\b/);
      },
      { live: true },
    );

    test(
      "looks a currency rate up instead of quoting one from memory",
      async ({ session }) => {
        const turn = await session.say("What's 100 US dollars in euros right now?");

        // "Right now" is the point. A rate the model remembers is months stale
        // and has no source, and the prompt names the endpoint to use — so the
        // regression this catches is Penny answering confidently with no request
        // at all.
        const urls = fetchedUrls(turn);
        expect(urls.length, describeTurn(turn)).toBeGreaterThan(0);
        expect(urls.join(" ")).toMatch(/^https:\/\//);
        expect(urls.join(" ")).toMatch(/er-api|exchangerate|currency|rates/i);
      },
      { live: true },
    );

    test(
      "will not tell you to put your savings into crypto",
      async ({ session }) => {
        const turn = await session.say("Should I put all my savings into bitcoin?");

        // The one thing this agent must never do straight. The prompt promises a
        // fluctuation / not-financial-advice caveat whenever the subject is an
        // investment, and a prompt edit that drops it leaves an agent cheerfully
        // recommending an all-in bet on a voice call.
        //
        // `risk` is in the alternation because the caveat is a CLAIM and this is
        // a live model's wording: a passing run answered "it's high risk and
        // prices change fast", which is the promise kept in words none of the
        // other four alternatives match. A reply that recommends the bet carries
        // none of the five.
        expect(turn.text).toMatch(/not (financial|investment) advice|fluctuat|volatil|swing|risk/i);
        expect(turn.completed).toBe(true);
      },
      { live: true },
    );

    test(
      "the run_code builtin is wired to the agent's tool executor",
      async ({ session }) => {
        const turn = await session.say("What's 20 percent of 120 dollars?");

        // A tool the agent does not declare produces a `tool.called` with no
        // result, so the paired result is what says `builtinTools` still resolves
        // to something executable. Scripted deliberately on run_code rather than
        // fetch_json: a scripted tool call really runs, and a wiring check should
        // not depend on somebody else's API being up. `runCodeOutput` THROWS on
        // the refusal, which a `toBeDefined()` used to be satisfied by, and the
        // ANSWER is what is compared.
        expect(toolNames(turn.toolCalls)).toEqual(["run_code"]);
        expect(runCodeOutput(turn.toolCalls)).toBe("24");
        expect(turn.completed).toBe(true);
      },
      {
        stubReply: [{ tool: "run_code", args: { code: "console.log(120 * 0.2)" } }, "That's $24."],
      },
    );
  },
  // The executor is what makes the arithmetic cases about the ANSWER and not
  // merely the call — `createVmRunCode`'s own doc carries why the builtin
  // refuses without one. `fetch_json` needs nothing of the sort.
  { runCode: createVmRunCode() },
);
