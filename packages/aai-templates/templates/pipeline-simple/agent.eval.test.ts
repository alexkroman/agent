// An EVAL: does the swapped-in stage actually answer? Run it with `aai eval`.
//
// `agent.test.ts` asserts the DESCRIPTOR — `llm.kind === "anthropic"`, the two
// unset stages filling to AssemblyAI in the deployable config. It runs no agent,
// so it cannot tell a working provider from a model id that was retired last
// month: `toAgentConfig` is happy either way. This file is the other half. A
// live run here opens a real Anthropic connection with the real model string,
// which is the one claim this template makes and the one that rots on its own.
//
// **A live run needs ANTHROPIC_API_KEY, not the AssemblyAI key.** That is the
// template's own lesson arriving in the test suite: swap a stage and you bring
// that stage's credential. Without it `describeEval` announces SCRIPTED and the
// live-only case below is skipped — which is a wiring check, not a measurement,
// and the banner says so on every run.
import { describeEval } from "@alexkroman1/aai-runtime/eval/vitest";
import { expect } from "vitest";
import agentDef from "./agent.ts";

/** Roughly how many words a reply is, for the spoken-length claim. */
const wordCount = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length;

describeEval(agentDef, (test) => {
  test(
    "answers on the declared model, without reaching for a tool",
    async ({ session }) => {
      // `say()` hands back THAT turn, so this is a claim about the reply to
      // this question rather than about everything said so far — which already
      // includes the greeting.
      const turn = await session.say("What is the capital of France?");

      expect(turn.completed).toBe(true);
      expect(turn.text).toMatch(/paris/i);
      // This agent declares no tools and no builtins, so a tool call here
      // would mean something got added by accident.
      expect(turn.toolCalls).toEqual([]);
      expect(turn.events.some((e) => e.type === "error.reported")).toBe(false);
    },
    { stubReply: "Paris is the capital of France." },
  );

  test(
    "keeps the thread across two turns",
    async ({ session }) => {
      await session.say("My name is Sam and I work in Berlin.");
      const turn = await session.say("Which city did I say I work in?");

      expect(turn.text).toMatch(/berlin/i);
      expect(turn.events.some((e) => e.type === "error.reported")).toBe(false);
    },
    // One scripted reply per turn: the second is the one under test, and a
    // script that answered only the first would fail the case it is meant to
    // let run. Scripted, the claim is that the session drives two turns; live,
    // it is that the model still has the first one.
    { stubReply: ["Good to meet you, Sam.", "You said Berlin."] },
  );

  test(
    "keeps a reply speakable, even when the question invites an essay",
    async ({ session }) => {
      const turn = await session.say(
        "Tell me everything you know about the history of the Roman Empire.",
      );

      // This template ships no prompt of its own, so what holds the reply down
      // is `DEFAULT_SYSTEM_PROMPT`'s SPEAKING section — two sentences, about
      // thirty spoken words, no markdown. That is a measured rule (interruption
      // rate climbs from 17% under ten words to 59% past thirty-five), and a
      // stage swap that quietly loses it produces an agent nobody can hold a
      // call with. The ceiling is generous against the rule's own thirty so the
      // case fails on an essay rather than on a long sentence.
      expect(wordCount(turn.text)).toBeLessThanOrEqual(80);
      expect(turn.text).not.toMatch(/[*#`]|^\s*[-•]\s/m);
    },
    // Live only: a scripted reply's length is this file's own choice, so
    // asserting it in stub mode would measure nothing.
    { live: true },
  );
});
