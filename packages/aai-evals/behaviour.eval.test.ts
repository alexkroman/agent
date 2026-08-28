// Copyright 2026 the AAI authors. MIT license.
/**
 * LEVEL 1: given this utterance, did the agent do the right thing?
 *
 * Four cases against one small support agent, each asserting over the session's
 * own typed event stream: tool choice, tool arguments, tool ORDER across turns,
 * what the agent said, the event ordering a turn produces, and the step count.
 * Every one of those is a question this repository could not ask of itself
 * before — the numbers its guides quote all came from harnesses that live
 * elsewhere, one of which no longer exists.
 *
 * **These cases cannot see an endpointing bug, a split utterance, a merge, or a
 * barge-in.** All four are properties of the audio boundary, which
 * the fake speech stages remove; that is LEVEL 2, and it is not built. Nothing here
 * should be read as covering it.
 *
 * @module
 */

import { agent, tool } from "@alexkroman1/aai";
import { withTools } from "@alexkroman1/aai/manifest";
import { openEvalSession } from "@alexkroman1/aai-runtime/eval";
import { z } from "zod";
import { describeEvalTier, evalApiKey } from "./_gate.ts";
import { registerEvalCases } from "./_register.ts";
import { scopeOf } from "./assertions.ts";

/** The two orders the fixture agent knows about. */
const ORDERS: Record<string, { status: string; item: string }> = {
  W1234: { status: "shipped", item: "blue running shoes" },
  W9876: { status: "pending", item: "wool socks" },
};

/**
 * The agent under eval: two tools, one clear job, and a system prompt that
 * spells out the tool discipline.
 *
 * Tools are attached with `withTools` rather than a `tools/` directory because a
 * fixture directory is what this file would otherwise be — the registry seam is
 * the same one the studio's own coding agent uses, and what level 1 measures is
 * the agent's BEHAVIOUR, not how its tool table was assembled.
 */
function supportAgent() {
  return withTools(
    agent({
      name: "Order Support",
      greeting: "Order support, how can I help?",
      systemPrompt: [
        "You are an order support agent. Be brief — one or two sentences.",
        "Look an order up with lookup_order before saying anything about it.",
        "Cancel an order only with cancel_order, and only when the caller asks to cancel.",
        "Never invent an order status. Read the caller's order number back digit for digit.",
      ].join(" "),
    }),
    {
      lookup_order: tool({
        description: "Look up one order's status by its order number.",
        inputSchema: z.object({ orderId: z.string().describe("e.g. W1234") }),
        execute: ({ orderId }) => {
          const found = ORDERS[orderId.trim().toUpperCase()];
          return found === undefined
            ? { error: `no order ${orderId}` }
            : { orderId, status: found.status, item: found.item };
        },
      }),
      cancel_order: tool({
        description: "Cancel one order by its order number.",
        inputSchema: z.object({ orderId: z.string() }),
        execute: ({ orderId }) => {
          const found = ORDERS[orderId.trim().toUpperCase()];
          return found === undefined
            ? { error: `no order ${orderId}` }
            : { orderId, cancelled: true };
        },
      }),
    },
  );
}

describeEvalTier("behaviour eval — level 1 (text-driven)", () => {
  const open = () =>
    openEvalSession({ agent: supportAgent(), env: { ASSEMBLYAI_API_KEY: evalApiKey() } });

  registerEvalCases([
    {
      name: "looks an order up with the number the caller said",
      async body(t) {
        const session = await open();
        try {
          await session.say("Hi, what's the status of order W one two three four?");
          const all = scopeOf(t, session);
          all.succeeded();
          all.noErrors();
          all.calledTool("lookup_order", { args: { orderId: "W1234" }, count: 1 });
          all.notCalledTool("cancel_order");
          all.saidSomething("shipped");
        } finally {
          await session.close();
        }
      },
    },
    {
      name: "cancels only after looking up, and only when asked",
      async body(t) {
        const session = await open();
        try {
          await session.say("What's happening with order W nine eight seven six?");
          await session.say("Please cancel it.");
          const all = scopeOf(t, session);
          all.succeeded();
          all.toolOrder(["lookup_order", "cancel_order"]);
          all.maxToolCalls(4);
          // The greeting is turn 0, so the caller's two turns are 1 and 2.
          all.turn(1).notCalledTool("cancel_order");
          all.turn(2).calledTool("cancel_order", { args: { orderId: "W9876" } });
          all.saidSomething(/cancel/i);
        } finally {
          await session.close();
        }
      },
    },
    {
      name: "answers a closing turn without reaching for a tool",
      async body(t) {
        const session = await open();
        try {
          await session.say("That's all I needed, thanks very much.");
          const all = scopeOf(t, session);
          all.succeeded();
          all.turn(1).usedNoTools();
        } finally {
          await session.close();
        }
      },
    },
    {
      name: "a tool turn produces the event sequence a client depends on",
      async body(t) {
        const session = await open();
        try {
          await session.say("Is order W1234 on its way?");
          const all = scopeOf(t, session);
          all.eventOrder([
            "session.configured",
            "user-transcript.committed",
            "tool.called",
            "tool.completed",
            "agent-transcript.committed",
            "reply.completed",
          ]);
          all.notEvent("reply.cancelled");
          all.notEvent("error.reported");
          // Every call the model made was answered — a `tool.called` with no
          // `tool.completed` is a turn the caller hears go silent.
          all.eventsSatisfy("every tool.called was answered", (events) => {
            const called = events.filter((e) => e.type === "tool.called").length;
            const completed = events.filter((e) => e.type === "tool.completed").length;
            return called === completed;
          });
        } finally {
          await session.close();
        }
      },
    },
  ]);
});
