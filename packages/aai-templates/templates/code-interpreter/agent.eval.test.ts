// An EVAL: does Coda actually answer by RUNNING CODE? Run it with `aai eval`.
//
// `agent.test.ts` asserts about the config; this drives the real thing — the
// real session, the real tool executor, the real event stream, with only the
// microphone and the speaker faked.
//
// Two things about this file are worth copying into any template eval.
//
// **The prompt is applied here, because `system-prompt.md` IS the prompt and
// nothing in `agent.ts` imports it.** Discovery happens where the bundle is
// assembled (`aai build` reads the file; a spec does the same lowering), so an
// eval that drove `agent.ts` alone would measure an agent running on
// `DEFAULT_SYSTEM_PROMPT` — i.e. not the agent anybody deploys, and every claim
// this file makes about Coda's rules would be a claim about nothing.
//
// **`run_code` refuses unless the EVAL supplies an executor.** A deployed agent
// runs it only inside the guest sandbox — the Modal container is the security
// boundary — so off-platform the builtin declines rather than evaluating
// model-written JavaScript in the host process. That is right, and it left this
// template's whole subject assertable as a CALL and never as an answer: a
// `toBeDefined()` on the result is satisfied by the refusal itself. So the suite
// passes `createVmRunCode()` — a developer's own machine may evaluate generated
// code, a deployment may not — and every case here asserts BOTH halves: that
// Coda reached for code, and what the code came back with.

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
 * for: `args` is `Record<string, unknown>` on the wire — the model wrote it and
 * nothing validated it — so the `String(c.args.code ?? "")` this replaced turned
 * an argument Coda renamed, or never sent, into `""`, and every claim below about
 * the code she wrote would have been a claim about an empty string. A `code`
 * that stops arriving FAILS here, naming the field.
 */
const RunCodeArgs = z.object({ code: z.string() });
const codeIn = (turn: EvalTurn) =>
  toolArgsIn(turn.toolCalls, "run_code", RunCodeArgs)
    .map((args) => args.code)
    .join("\n");

/**
 * A `run_code` executor, so these cases can assert the ANSWER and not merely the
 * call — `createVmRunCode`'s own doc carries why the builtin refuses without one
 * and why a `node:vm` context is the right thing to hand it here.
 */
const runCode = createVmRunCode();

describeEval(
  agentDef,
  (test) => {
    test(
      "writes code for arithmetic instead of answering from its head",
      async ({ session }) => {
        const turn = await session.say("What is 127 times 849?");

        // The template's CRITICAL RULE, and the whole reason it declares
        // run_code: a model that answers this one directly has regressed, and it
        // is the easiest question in the file to answer wrongly with confidence.
        expect(turn.toolCalls.map((c) => c.name)).toContain("run_code");
        const code = codeIn(turn);
        expect(code).toContain("127");
        expect(code).toContain("849");

        // And the code RAN, and got it right. That half needed an executor: with
        // none, `run_code` answers "only available in the sandboxed runtime", so
        // every claim above passes for an agent that then does the sum in its
        // head — which is the exact regression the CRITICAL RULE exists to stop.
        const output = toolResultsIn(turn.toolCalls, "run_code").join("\n");
        expect(output, `run_code printed: ${output}`).toContain("107823");

        // "Report RESULTS, never intentions": the call goes out before Coda says
        // anything, rather than after a sentence announcing it.
        const firstTool = turn.events.findIndex((e) => e.type === "tool.called");
        const firstSaid = turn.events.findIndex((e) => e.type === "agent-transcript.committed");
        expect(firstSaid).toBeGreaterThan(-1);
        expect(firstTool).toBeGreaterThan(-1);
        expect(firstTool).toBeLessThan(firstSaid);
      },
      { live: true },
    );

    test(
      "reaches for code for a calendar question too, not just sums",
      async ({ session }) => {
        const turn = await session.say("What day of the week was January 1st, 2000?");

        // The prompt lists this exact question under "you MUST use code for".
        // It is the case a narrower reading of the rule ("code is for maths")
        // silently drops.
        expect(turn.toolCalls.map((c) => c.name)).toContain("run_code");
        expect(codeIn(turn)).toMatch(/Date|2000/);
        // The code RAN rather than being refused — but the ANSWER is
        // deliberately not asserted here, and the reason is worth knowing before
        // adding it back. Coda writes `new Date("2000-01-01").getDay()`, which
        // parses as UTC midnight and is then read in LOCAL time: correct in the
        // guest sandbox (UTC, Saturday) and one day out on any developer west of
        // Greenwich (measured: this printed "Friday"). Asserting the weekday
        // would measure the machine running the eval. The two arithmetic cases
        // in this suite have no such dependency and do assert their answers.
        const output = toolResultsIn(turn.toolCalls, "run_code").join("\n");
        expect(output, `run_code printed: ${output}`).not.toMatch(
          /only available in the sandboxed runtime/,
        );
        expect(output).not.toBe("");
      },
      { live: true },
    );

    test(
      "the run_code builtin is wired to the agent's tool executor",
      async ({ session }) => {
        const turn = await session.say("Add one and one for me.");

        // The wiring claim, and it really discriminates: a tool the agent does
        // NOT declare produces a `tool.called` with no result at all, so the
        // paired result is what says `builtinTools: ["run_code"]` still resolves
        // through to an executable tool.
        //
        // `toBeDefined()` used to be the whole assertion, and it was satisfied by
        // the REFUSAL — "run_code is only available in the sandboxed runtime" is a
        // defined result. Asserting the printed answer is what makes this a claim
        // about the executor rather than about the string it declined with.
        const [call] = turn.toolCalls;
        expect(call?.name).toBe("run_code");
        expect(call?.result).toBe("2");
        expect(turn.completed).toBe(true);
      },
      { stubReply: [{ tool: "run_code", args: { code: "console.log(1 + 1)" } }, "That's two."] },
    );
  },
  // `runCode` is what makes these cases about the ANSWER and not just the call.
  { runCode },
);
