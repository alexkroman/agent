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
import { describeEval } from "@alexkroman1/aai-runtime/eval/vitest";
import { expect } from "vitest";
import agentDef from "./agent.ts";

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
      // This agent has no tools, so reaching for one would be a real finding.
      expect(turn.toolCalls).toEqual([]);
    },
    { stubReply: "Paris is the capital of France." },
  );

  test(
    "keeps the thread across two turns",
    async ({ session }) => {
      await session.say("My name is Sam.");
      const turn = await session.say("What did I say my name was?");

      expect(turn.text).toMatch(/sam/i);
      expect(session.events().some((e) => e.type === "error.reported")).toBe(false);
    },
    // One reply per turn: the second is the one under test, and a stub that
    // answered the first would fail the case it is supposed to let run.
    { stubReply: ["Nice to meet you, Sam.", "You said your name was Sam."] },
  );
});
