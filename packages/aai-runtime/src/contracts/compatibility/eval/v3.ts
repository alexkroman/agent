// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-runtime:eval` epoch 3.
 *
 * This must keep compiling against current source for as long as epoch 3 is
 * advertised as supported. Editing it to make an error go away defeats the
 * mechanism — the error IS the finding, and the answer is a source fix or
 * `node scripts/api-contracts.mjs --bump aai-runtime:eval --drop "<reason>"`.
 *
 * It is the TEXT half, which is what epoch 3 added: `describeTextEval` and its
 * three types, plus `evalTextCredentials`, the gate that decides whether a text
 * suite can run live. Epoch 2's own note points here — "nothing here uses
 * `describeTextEval` … those are what moved the capability to epoch 3" — so
 * this file is deliberately about those five names and `v1.ts`/`v2.ts` carry
 * the sixty-nine the capability promised before them.
 *
 * ## What moved, and why epoch 3 survives it
 *
 * `HostGenerateFn` — published by this capability in its own right, and what
 * `EvalSessionOptions.generate` takes — grew an optional `onUsage` in its
 * CALL-OPTIONS bag, so `ctx.generate` reports its tokens to the session's usage
 * meter. That is the widening that keeps this file compiling: a case may pass a
 * `generate` of its own and ignore the new field (an implementer whose bag
 * names only `signal` still assigns), and a case that passes none — every case
 * below, and every text case, since `EvalTextAgentOptions` has no such field —
 * cannot see the change at all.
 *
 * The direction that WOULD break is the bag narrowing back, or `onUsage`
 * becoming required: a suite holding a scripted `HostGenerateFn` would then
 * have to grow a parameter it never asked for.
 *
 * ## Two things about its SHAPE, both imposed rather than chosen
 *
 * **Coverage is measured per CAPABILITY, not per file.** The gate
 * (`api-contracts-gate.test.ts`, "frozen examples import what its epochs
 * promised") asks that every name a retained epoch promised is imported by ONE
 * of that capability's frozen examples, because a capability with several
 * retained epochs splits its surface between them on purpose. This is that
 * split, said in place: three files, one story each, rather than a third
 * near-copy of a sixty-nine-name roll-call.
 *
 * **Its imports are RELATIVE.** The same gate insists, and rightly: importing
 * `@alexkroman1/aai-runtime/eval/vitest` would resolve through the package's
 * own `exports` map to whatever the current build publishes, so the fixture
 * would prove the CURRENT surface compiles rather than that epoch 3's does.
 *
 * @module
 */

import { agent, tool } from "@alexkroman1/aai";
import { toolRegistry, withTools } from "@alexkroman1/aai/manifest";
import { expect } from "vitest";
import { z } from "zod";
import { errorsIn, evalTextCredentials, toolNames } from "../../../eval-barrel.ts";
import {
  type DescribeTextEvalOptions,
  describeTextEval,
  type EvalTextTest,
  type EvalTextTestContext,
} from "../../../eval-vitest-barrel.ts";

// ─── The agent under evaluation ──────────────────────────────────────────────
// EDIT POINT: in a real project this is `import agentDef from "./agent.ts"`, or
// `from "virtual:aai/agent"` when the prompt and `tools/` are discovered.

const lookUpOrder = tool({
  description: "Look up an order by its id.",
  inputSchema: z.object({ id: z.string() }),
  execute: ({ id }) => ({ id, status: "shipped" as const }),
});

// `text: true` is what makes this a text-eval subject at all — `describeEval`
// would open a voice session with two speech stages to fake, and
// `describeTextEval` opens a conversation instead.
const agentDef = withTools(
  agent({
    name: "Orders Chat",
    text: true,
    systemPrompt: "Look an order up before you say anything about it.",
  }),
  toolRegistry({ "tools/look_up_order.ts": { default: lookUpOrder } }),
);

// ─── EDIT POINT: what the suite supplies every conversation ──────────────────
//
// `DescribeTextEvalOptions` is `EvalTextAgentOptions` minus the agent, because
// the suite already named it. What belongs here is per-DEPLOYMENT — the env a
// tool reads, a tool deadline a slow tool needs — and never per case; a case
// says what the model does, through `stubReply`.
const SUITE: DescribeTextEvalOptions = {
  env: {},
  toolTimeoutMs: 60_000,
};

// ─── EDIT POINT: whether this machine can run the suite live ─────────────────
//
// The gate `describeTextEval` applies internally, exposed so a project can ask
// it in its own words — a CI job that must not silently degrade to the scripted
// model reads `ready` and fails instead. `evalCredentials` is the voice sibling
// and OVER-ASKS here: it adds the default STT key a text agent never reads.
export function liveReadiness(): { readonly ready: boolean; readonly why: string } {
  const credentials = evalTextCredentials(agentDef);
  return {
    ready: credentials.ready,
    why: credentials.reason ?? `nothing missing (${credentials.missing.length} keys unset)`,
  };
}

describeTextEval(
  agentDef,
  (test: EvalTextTest) => {
    test(
      "looks an order up rather than answering from memory",
      async ({ agent: chat }: EvalTextTestContext) => {
        const turn = await chat.send("Where is order W1?");

        // The finding this case exists for: an agent that answers from the id
        // alone reads exactly like one that looked it up.
        expect(toolNames(turn.toolCalls)).toContain("look_up_order");
        expect(turn.text).not.toBe("");
        expect(turn.completed).toBe(true);
        // Over the whole conversation, so a tool that threw is not mistaken for
        // a model that chose not to call it.
        expect(errorsIn(chat.events())).toEqual([]);
      },
      { stubReply: [{ tool: "look_up_order", args: { id: "W1" } }, "It shipped on Tuesday."] },
    );

    test(
      "the conversation outlives the turn, which is what `send` twice proves",
      async ({ agent: chat, mode }: EvalTextTestContext) => {
        const turns = await chat.sendAll(["Where is order W1?", "And what did I just ask about?"]);

        expect(turns).toHaveLength(2);
        expect(chat.toolCalls().map((call) => call.name)).toContain("look_up_order");
        // Pinned flatly rather than behind an `if (mode === …)`, because
        // `scripted` below already decided the mode: this case never runs live,
        // so there is no model free to phrase the recall differently. `mode` is
        // read for the failure message and nothing else.
        expect(chat.said().join(" "), `mode: ${mode}`).toContain("W1");
      },
      {
        // A live model may reasonably answer the second question without
        // looking anything up, so the claim only means something against a
        // script — the mirror of `{ live: true }`.
        scripted: true,
        stubReply: [
          { tool: "look_up_order", args: { id: "W1" } },
          "It shipped on Tuesday.",
          "You asked about order W1.",
        ],
      },
    );
  },
  SUITE,
);
