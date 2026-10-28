// An EVAL: does Kitchen Coach do the arithmetic with its tool rather than in its head, and
// say the result the way a cook measures? Run it with `aai eval`.
//
// get_kitchen and start_timer are client tools: the open PAGE answers them, and an eval
// session has no page. So the cases here are the server-side tool; what the page answers
// is the plain functions in shared.ts, which agent.test.ts drives.
//
// Without a provider key every case runs against a SCRIPTED model (its `stubReply`): the
// real session and the real tool, a fake reply. That proves the wiring and nothing about
// the choice.

import agentDef from "virtual:aai/agent";
import { describeEval, expectCalled, toolResultIn } from "@alexkroman1/aai-runtime/testing/vitest";
import { expect } from "vitest";
import scaleAmount from "./tools/scale_amount.ts";

describeEval(agentDef, (test) => {
  test(
    "a recipe written for four is scaled for six with scale_amount",
    async ({ session }) => {
      const turn = await session.say(
        "The recipe says three quarters of a cup of rice and it serves four. I'm cooking for six. How much rice?",
      );
      expectCalled(turn, scaleAmount);
      expect(toolResultIn(turn.toolCalls, scaleAmount)?.amount).toBeCloseTo(1.13, 2);
      expect(turn.text.toLowerCase()).toContain("quarter");
    },
    {
      stubReply: [
        {
          tool: "scale_amount",
          args: { amount: 0.75, unit: "cup", from_servings: 4, to_servings: 6 },
        },
        "That's one and a quarter cups of rice.",
      ],
    },
  );
});
