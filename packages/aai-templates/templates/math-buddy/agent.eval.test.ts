// An EVAL: does Math Buddy delegate every calculation to code? Run it with
// `aai eval`.
//
// This tutor's whole design is "the model does the talking, run_code does the
// arithmetic" — which is also why it runs on Flash-Lite. So the claim worth
// pinning is not that the answer is right, it is that the answer came from
// CODE, and that the code is the recipe the prompt gave.
//
// Two things this file has to work around, both explained at length in
// `../code-interpreter/agent.eval.test.ts`: `system-prompt.md` is discovered by
// the build rather than imported, so an eval has to apply it or it measures a
// different agent; and `run_code` refuses unless the EVAL supplies an executor,
// which this suite does — so the cases below assert the answer the code came
// back with as well as the code the tutor wrote. `runCodeIn` reads the code
// through a schema and `runCodeOutput` THROWS on the refusal, so neither claim
// can hold against an empty string or the sentence the builtin declines with.

import agentDef from "virtual:aai/agent";
import {
  createVmRunCode,
  describeTurn,
  runCodeIn,
  runCodeOutput,
  toolNames,
} from "@alexkroman1/aai-runtime/eval";
import { describeEval } from "@alexkroman1/aai-runtime/eval/vitest";
import { expect } from "vitest";

describeEval(
  agentDef,
  (test) => {
    test(
      "converts units in code, with a real conversion factor",
      async ({ session }) => {
        const turn = await session.say("Convert 5 miles to kilometres.");

        // The prompt hands the tutor the factors; the finding it guards against
        // is a tutor that recites a remembered figure instead. A factor in the
        // code is the evidence that the conversion was computed, not recalled.
        expect(toolNames(turn.toolCalls), describeTurn(turn)).toContain("run_code");
        const code = runCodeIn(turn.toolCalls);
        expect(code).toContain("5");
        expect(code).toMatch(/1\.60|1\.61|0\.621|8\.04/);
        // And the factor was applied rather than merely mentioned: five miles is
        // 8.0467 km, so whatever rounding the tutor chose the answer starts 8.0.
        const output = runCodeOutput(turn.toolCalls);
        expect(output, `run_code printed: ${output}`).toMatch(/8\.0/);
      },
      { live: true },
    );

    test(
      "rolls dice with a random draw rather than inventing numbers",
      async ({ session }) => {
        const turn = await session.say("Roll 3 twenty-sided dice for me.");

        // A model asked for dice will happily make three numbers up, and the
        // reply is indistinguishable from a real roll. `Math.random` in the code
        // is the only thing that tells them apart.
        expect(toolNames(turn.toolCalls), describeTurn(turn)).toContain("run_code");
        const code = runCodeIn(turn.toolCalls);
        expect(code).toMatch(/Math\.random/);
        expect(code).toContain("20");
        expect(code).toContain("3");

        // And the draw really happened: three integers, every one of them a legal
        // face of a twenty-sided die. `Math.random` in the code says the tutor
        // asked for a roll; this says it GOT one — a `run_code` that refused
        // would have thrown out of `runCodeOutput` before any die was counted.
        const output = runCodeOutput(turn.toolCalls);
        const rolled = [...output.matchAll(/\d+/g)].map((m) => Number(m[0]));
        expect(rolled.length, `run_code printed: ${output}`).toBeGreaterThanOrEqual(3);
        for (const face of rolled) {
          expect(face, `run_code printed: ${output}`).toBeGreaterThanOrEqual(1);
          expect(face, `run_code printed: ${output}`).toBeLessThanOrEqual(20);
        }
      },
      { live: true },
    );

    test(
      "the run_code builtin is wired to the agent's tool executor",
      async ({ session }) => {
        const turn = await session.say("What is 127 times 849?");

        // A tool the agent does not declare produces a `tool.called` with no
        // result, so the paired result is what says `builtinTools: ["run_code"]`
        // still resolves to something executable. `runCodeOutput` THROWS on the
        // refusal, which a `toBeDefined()` used to be satisfied by, and the
        // ANSWER is what is compared.
        expect(toolNames(turn.toolCalls)).toEqual(["run_code"]);
        expect(runCodeOutput(turn.toolCalls)).toBe("107823");
        expect(turn.completed).toBe(true);
      },
      {
        stubReply: [
          { tool: "run_code", args: { code: "console.log(127 * 849)" } },
          "That's 107,823.",
        ],
      },
    );
  },
  // The executor is what makes these cases about the ANSWER and not just the
  // call — `createVmRunCode`'s own doc carries why the builtin refuses without one.
  { runCode: createVmRunCode() },
);
