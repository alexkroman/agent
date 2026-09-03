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
// back with as well as the code the tutor wrote.

import agentDef from "virtual:aai/agent";
import {
  createVmRunCode,
  type EvalTurn,
  toolArgsIn,
  toolResultsIn,
} from "@alexkroman1/aai-runtime/eval";
import { describeEval } from "@alexkroman1/aai-runtime/eval/vitest";
import { expect } from "vitest";
import { z } from "zod";

/**
 * The code every `run_code` call in this turn carried, joined.
 *
 * Read through `toolArgsIn` WITH a schema, which is what that reader takes one
 * for: `args` is `Record<string, unknown>` on the wire — the tutor wrote it and
 * nothing validated it — so the `String(c.args.code ?? "")` this replaced turned
 * an argument the model renamed, or never sent, into `""`. The claims below are
 * about the recipe the tutor wrote, and against `""` every one of them would
 * have been a claim about nothing. A `code` that stops arriving FAILS here,
 * naming the field.
 */
const RunCodeArgs = z.object({ code: z.string() });
const codeIn = (turn: EvalTurn) =>
  toolArgsIn(turn.toolCalls, "run_code", RunCodeArgs)
    .map((args) => args.code)
    .join("\n");

/**
 * A `run_code` executor, so these cases can assert the answer the tutor's code
 * came back with and not merely the code — `createVmRunCode`'s own doc carries
 * why the builtin refuses without one.
 */
const runCode = createVmRunCode();

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
        expect(turn.toolCalls.map((c) => c.name)).toContain("run_code");
        const code = codeIn(turn);
        expect(code).toContain("5");
        expect(code).toMatch(/1\.60|1\.61|0\.621|8\.04/);
        // And the factor was applied rather than merely mentioned: five miles is
        // 8.0467 km, so whatever rounding the tutor chose the answer starts 8.0.
        const output = toolResultsIn(turn.toolCalls, "run_code").join("\n");
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
        expect(turn.toolCalls.map((c) => c.name)).toContain("run_code");
        const code = codeIn(turn);
        expect(code).toMatch(/Math\.random/);
        expect(code).toContain("20");
        expect(code).toContain("3");

        // And the draw really happened: three integers, every one of them a legal
        // face of a twenty-sided die. `Math.random` in the code says the tutor
        // asked for a roll; this says it GOT one — a `run_code` that refused
        // prints a sentence with no dice in it at all.
        const output = toolResultsIn(turn.toolCalls, "run_code").join("\n");
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
        // still resolves to something executable. The ANSWER rather than
        // `toBeDefined()`, which the refusal string satisfied too.
        const [call] = turn.toolCalls;
        expect(call?.name).toBe("run_code");
        expect(call?.result).toBe("107823");
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
  // `runCode` is what makes these cases about the ANSWER and not just the call.
  { runCode },
);
