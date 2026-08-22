// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:dialog` epoch 2.
 *
 * Epoch 2 is epoch 1 RENAMED: `flow()` is `dialog()`, and `Flow` /
 * `FlowPosition` / `FlowToolDef` / `FlowToolResult` / `FlowOptions` are
 * `Dialog` / `DialogPosition` / `DialogToolDef` / `DialogToolResult` /
 * `DialogOptions`. Nothing else moved — same statechart, same execution-time
 * gate, same refusal that names where the conversation is.
 *
 * The rename is about the import line. `flow` sat in one barrel beside
 * `workflow`, meaning something entirely different (where a CONVERSATION is,
 * against durable work that outlives the session), and beside `graph()`, whose
 * name said as little about which of the two an author wanted.
 * `dialog()` / `procedure()` / `workflow()` names the three by their jobs.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative.
 */

import { setup } from "xstate";
import { z } from "zod";

import { dialog } from "../../../index.ts";

const machine = setup({
  types: {} as { events: { type: "VERIFIED" } | { type: "QUOTED" } },
}).createMachine({
  id: "claim",
  initial: "verifying",
  states: {
    verifying: {
      meta: { instruction: "Get the caller's policy number and verify it." },
      on: { VERIFIED: "quoting" },
    },
    quoting: {
      meta: { instruction: "Read the excess disclosure, then quote." },
      on: { QUOTED: "done" },
    },
    done: { type: "final" },
  },
});

/** The declaration: a store key, a machine, and nothing else. */
export const claim = dialog("claim", machine);

/**
 * A gated tool. `when` is checked against the machine's own states when this is
 * DECLARED, so a typo is a startup throw rather than a tool that is silently
 * unreachable for the life of the agent.
 */
export const quoteClaim = claim.tool({
  description: "Quote the claim once the policy is verified",
  inputSchema: z.object({ excess: z.number() }),
  when: "quoting",
  send: { type: "QUOTED" },
  execute: ({ excess }) => ({ premium: excess * 2 }),
});

/** The position, projected to a client so a page can render the step. */
export const progress = claim.projection((at) => ({ state: at.state, done: at.done }));
