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
// supplies one built by `createVmRunCode` — a developer's own machine may run
// generated code, a deployment may not — and every case here asserts BOTH: that
// Coda reached for code (`runCodeIn`, the code read through a schema), and what
// the code came back with (`runCodeOutput`, which THROWS on the refusal rather
// than handing it back as output).

import agentDef from "virtual:aai/agent";
import {
  createVmRunCode,
  describeTurn,
  expectToolBeforeSpeech,
  type RunCodeExecutor,
  runCodeIn,
  runCodeOutput,
  toolNames,
  type VmRunCodeOptions,
} from "@alexkroman1/aai-runtime/eval";
import { describeEval } from "@alexkroman1/aai-runtime/eval/vitest";
import { expect } from "vitest";

/**
 * The vm executor's budget, set to the DEPLOYED one rather than left at the
 * default.
 *
 * `createVmRunCode` defaults to one second, which is the smallest thing that
 * stops a model's `while (true) {}` from hanging a case to the suite deadline.
 * The guest sandbox gives a real `run_code` call five (`RUN_CODE_TIMEOUT_MS`,
 * enforced by terminating the worker thread the snippet runs in), so at the
 * default this suite is four seconds STRICTER than production: a snippet that
 * a deployed Coda completes — a sieve over a big range, a brute-force search,
 * the kind of thing a prompt forbidding mental arithmetic invites — comes back
 * as a timed-out `{ "error": … }` here, and the case measures the harness's
 * deadline instead of the agent. The other knob is `globals`, and
 * everything in it is a capability grant into a context that can reach the
 * host realm; this suite needs none, so the executor sees `console.log` and
 * nothing else.
 */
const VM_RUN_CODE: VmRunCodeOptions = { timeoutMs: 5000 };

/**
 * What makes these cases about the ANSWER and not just the call.
 *
 * Annotated with the type the PLATFORM fills: the guest harness hands the
 * runtime its in-sandbox executor under exactly this signature, so what the
 * suite substitutes is the implementation and not the seam. `createVmRunCode`'s
 * own doc carries why the builtin refuses without one, and why a `node:vm`
 * context — an isolation boundary for accidents, not for adversaries — is the
 * right thing to hand it on a developer's own machine and the wrong thing to
 * deploy.
 */
const runCode: RunCodeExecutor = createVmRunCode(VM_RUN_CODE);

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
        expect(toolNames(turn.toolCalls), describeTurn(turn)).toContain("run_code");
        const code = runCodeIn(turn.toolCalls);
        expect(code).toContain("127");
        expect(code).toContain("849");

        // And the code RAN, and got it right. That half needed an executor: with
        // none, `run_code` answers its refusal, and every claim above passes for
        // an agent that then does the sum in its head — which is the exact
        // regression the CRITICAL RULE exists to stop. `runCodeOutput` throws on
        // that refusal rather than letting it be compared.
        const output = runCodeOutput(turn.toolCalls);
        expect(output, `run_code printed: ${output}`).toContain("107823");

        // "Report RESULTS, never intentions": the call goes out before Coda says
        // anything, rather than after a sentence announcing it.
        expectToolBeforeSpeech(turn);
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
        expect(toolNames(turn.toolCalls), describeTurn(turn)).toContain("run_code");
        expect(runCodeIn(turn.toolCalls)).toMatch(/Date|2000/);
        // The code RAN rather than being refused (`runCodeOutput` throws on the
        // refusal) — but the ANSWER is deliberately not asserted here, and the
        // reason is worth knowing before adding it back. Coda writes
        // `new Date("2000-01-01").getDay()`, which parses as UTC midnight and is
        // then read in LOCAL time: correct in the guest sandbox (UTC, Saturday)
        // and one day out on any developer west of Greenwich (measured: this
        // printed "Friday"). Asserting the weekday would measure the machine
        // running the eval. The two arithmetic cases in this suite have no such
        // dependency and do assert their answers.
        expect(runCodeOutput(turn.toolCalls)).not.toBe("");
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
        // the REFUSAL — a defined result. `runCodeOutput` throws on that string,
        // and asserting the printed answer is what makes this a claim about the
        // executor rather than about the sentence it declined with.
        expect(toolNames(turn.toolCalls)).toEqual(["run_code"]);
        expect(runCodeOutput(turn.toolCalls)).toBe("2");
        expect(turn.completed).toBe(true);
      },
      { stubReply: [{ tool: "run_code", args: { code: "console.log(1 + 1)" } }, "That's two."] },
    );

    test(
      "a snippet that throws is fixed and re-run, not answered from memory",
      async ({ session }) => {
        const turn = await session.say("What is 6 times 7?");

        // The fourth CRITICAL RULE — "If the code throws an error, fix it and
        // try again" — and the only one with no live case, because a competent
        // model does not emit a `ReferenceError` on request. `scripted` is the
        // marker for exactly that: a claim a live run cannot observe, which
        // without it costs a red run and then gets weakened until it observes
        // nothing.
        expect(toolNames(turn.toolCalls), describeTurn(turn)).toEqual(["run_code", "run_code"]);

        // Both calls' output, verbatim and in call order: the throw first, the
        // retry's answer second. What this really pins is that a failed
        // evaluation went BACK to the model rather than up to the harness —
        // `createVmRunCode` catches and answers `{ error }` precisely so the
        // agent is handed its own typo and the case measures what it did next.
        // A copy that let the throw propagate would fail this template's suite
        // on Coda's first bad snippet, which is why the SDK owns the executor.
        // `runCodeOutput` reads a code error as the result it is; the string it
        // throws on is the REFUSAL, and this is not one.
        const output = runCodeOutput(turn.toolCalls);
        expect(output, `run_code printed: ${output}`).toContain("is not defined");
        expect(output, `run_code printed: ${output}`).toContain("42");

        // And the reply still ended on its own terms. A tool error the model
        // can read is a step inside a turn, not a broken one.
        expect(turn.completed).toBe(true);
      },
      {
        scripted: true,
        stubReply: [
          // A `ReferenceError`, which is the failure a model actually makes —
          // it reaches for a binding it meant to define — rather than a
          // `SyntaxError`, which the vm would refuse before running anything.
          { tool: "run_code", args: { code: "console.log(sixTimesSeven)" } },
          { tool: "run_code", args: { code: "console.log(6 * 7)" } },
          "Forty-two.",
        ],
      },
    );
  },
  { runCode },
);
