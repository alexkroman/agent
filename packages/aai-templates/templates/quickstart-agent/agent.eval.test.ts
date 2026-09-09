/**
 * The def a DEPLOYED agent runs: authored, plus what `tools/` and
 * `system-prompt.md` declare.
 *
 * `./agent.ts` would be the wrong import even for a template this small.
 * Discovery happens where the bundle is assembled, so the authored export has
 * NO tools and the framework-default prompt — an eval driving it measures a
 * different agent than the one that deploys, and the tool-choice claim below
 * would pass or fail for the wrong reason.
 */
import agentDef from "virtual:aai/agent";
// An EVAL: does the agent actually behave? Run it with `aai eval`.
//
// A test asserts about the config (see agent.test.ts — it never calls a model).
// An eval drives the real thing: a real session, the real tool executor, the
// real event stream, with only the microphone and the speaker faked.
//
// `describeEval` picks the model for you and says which it picked:
//
//   * with a provider key — a LIVE model. This spends tokens, takes a few
//     seconds a case, and is a NOISY instrument: a model is probabilistic, so
//     one failure is a question, not a verdict. Re-run before believing either
//     answer.
//   * without one — a SCRIPTED model answering each case's `stubReply`. The
//     agent, the session and this file all really run, so what it proves is
//     that the wiring works. It proves nothing about what the agent SAYS.
//
// What no eval here can see: anything below the audio boundary — where the
// agent decides you stopped talking, how it handles being interrupted, whether
// two sentences merged into one turn. Those need real paced audio.
import { errorsIn, toolNames } from "@alexkroman1/aai-runtime/eval";
import { describeEval } from "@alexkroman1/aai-runtime/eval/vitest";
import { expect } from "vitest";

describeEval(agentDef, (test) => {
  test(
    "answers a question in its own voice",
    async ({ session }) => {
      // `say()` hands back THAT turn, so the claim is about the reply to this
      // question — not about everything said so far, which already includes
      // the agent's greeting.
      const turn = await session.say("What is the capital of France?");

      expect(turn.completed).toBe(true);
      expect(turn.text).toMatch(/paris/i);
      // The agent's one tool looks up WEATHER, so reaching for it here would
      // be a real finding — not "this agent has no tools", which is what this
      // line used to say and stopped being true the day it got one.
      expect(turn.toolCalls).toEqual([]);
    },
    { stubReply: "Paris is the capital of France." },
  );

  test(
    "reaches for the tool that is only a FILE",
    async ({ session }) => {
      const turn = await session.say("What's the weather in Denver?");

      // The claim the quickstart makes about this project: `get_weather` is a
      // file in `tools/` that nothing imports and nothing registers, and this
      // is the case that would notice if the directory went missing — a
      // scripted run still boots the agent and still executes the tool a
      // script names, so it checks the wiring even with no key set.
      expect(toolNames(turn.toolCalls)).toEqual(["get_weather"]);
      expect(turn.text).toMatch(/denver/i);
    },
    // The tool really runs, and really calls wttr.in. Nothing here asserts on
    // what it answered: a service that is down returns the `{ error }` the
    // tool is written to hand back, and the claim is about the CHOICE.
    {
      stubReply: [
        { tool: "get_weather", args: { city: "Denver" } },
        "It's 54 degrees and clear in Denver.",
      ],
    },
  );

  test(
    "keeps the thread across two turns",
    async ({ session }) => {
      await session.say("My name is Sam.");
      const turn = await session.say("What did I say my name was?");

      expect(turn.text).toMatch(/sam/i);
      // Over the whole SESSION, greeting included: a failure prints the error
      // events themselves, where a boolean printed "expected true to be false".
      expect(errorsIn(session.events())).toEqual([]);
    },
    // One reply per turn: the second is the one under test, and a stub that
    // answered the first would fail the case it is supposed to let run.
    { stubReply: ["Nice to meet you, Sam.", "You said your name was Sam."] },
  );
});
