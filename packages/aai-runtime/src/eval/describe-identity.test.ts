// Copyright 2026 the AAI authors. MIT license.
/**
 * `describeEval`'s `clientId`/`phone`/`call`: set per suite, overridden or
 * CLEARED (`null`) per case, and a refused call readable from the case body.
 *
 * FORCED into stub mode at module scope, for `describe.test.ts`'s reason: the
 * mode is read at collection time, and without it this unit file would drive a
 * live model on whatever key the machine exports.
 */

import { agent, sessionCall, sessionClientId, sessionClientPhone, tool } from "@alexkroman1/aai";
import { withTools } from "@alexkroman1/aai/manifest";
import { expect, vi } from "vitest";
import { z } from "zod";
import { describeEval } from "./describe.ts";
import { toolResultIn } from "./events.ts";

vi.stubEnv("AAI_EVAL_STUB", "1");

const whoAmI = tool({
  description: "Report who this session is.",
  inputSchema: z.object({}),
  execute: (_args, ctx) => ({
    client: sessionClientId(ctx) ?? null,
    phone: sessionClientPhone(ctx) ?? null,
    call: sessionCall(ctx)?.parameters.call ?? null,
  }),
});

const identity = z.object({
  client: z.string().nullable(),
  phone: z.string().nullable(),
  call: z.string().nullable(),
});

/** A calling agent's gate: only a call it placed gets a session, and nothing else does. */
const caller = withTools(
  agent({
    name: "Identity Suite",
    sessionContext: ({ call }) => {
      if (call === undefined) return { refuse: "not a placed call" };
      return call.parameters.call?.startsWith("call_")
        ? undefined
        : { refuse: "not a call we placed" };
    },
  }),
  { who_am_i: whoAmI },
);

const ASK = { stubReply: [{ tool: "who_am_i", args: {} }, "Noted."] };

describeEval(
  caller,
  (test) => {
    test(
      "every case runs as the suite's client, phone and call",
      async ({ session }) => {
        const turn = await session.say("who is this?");
        expect(toolResultIn(turn.toolCalls, "who_am_i", identity)).toEqual({
          client: "eval-kitchen-speaker",
          phone: "+15035550100",
          call: "call_7f3a",
        });
      },
      ASK,
    );

    test(
      "a case overrides one field and keeps the suite's others",
      async ({ session }) => {
        const turn = await session.say("who is this?");
        expect(toolResultIn(turn.toolCalls, "who_am_i", identity)).toEqual({
          client: "eval-hallway-speaker",
          phone: "+15035550100",
          call: "call_7f3a",
        });
      },
      { ...ASK, clientId: "eval-hallway-speaker" },
    );

    test(
      "a case's `null` clears the suite's client id and phone, and keeps its call",
      async ({ session }) => {
        const turn = await session.say("who is this?");
        expect(toolResultIn(turn.toolCalls, "who_am_i", identity)).toEqual({
          client: null,
          phone: null,
          call: "call_7f3a",
        });
      },
      { ...ASK, clientId: null, phone: null },
    );

    test(
      "`call: null` is a session no carrier placed, inside a suite that sets one",
      async ({ session }) => {
        // The suite's call would have been let through; `null` removes it, so
        // the gate sees no call at all and refuses.
        expect(session.refused).toBe("not a placed call");
        await expect(session.say("hello?")).rejects.toThrow(/REFUSED/);
      },
      { call: null },
    );

    test(
      "a call the agent's sessionContext refuses is readable as session.refused",
      async ({ session }) => {
        expect(session.refused).toBe("not a call we placed");
        expect(session.said()).toEqual([]);
        await expect(session.say("hello?")).rejects.toThrow(/REFUSED/);
      },
      { call: { carrier: "twilio", parameters: { call: "someone-elses" } } },
    );
  },
  {
    clientId: "eval-kitchen-speaker",
    phone: "+1 503 555 0100",
    call: { carrier: "twilio", callId: "CA_eval_0001", parameters: { call: "call_7f3a" } },
  },
);
