// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-runtime:eval` epoch 5.
 *
 * This must keep compiling against current source for as long as epoch 5 is
 * advertised as supported. Editing it to make an error go away defeats the
 * mechanism — the error IS the finding, and the answer is a source fix or
 * `node scripts/api-contracts.mjs --bump aai-runtime:eval --drop "<reason>"`.
 *
 * ## What moved, and why epoch 5 survives it
 *
 * Epoch 6 added the SIMULATED CALLER and the JUDGE: `simulateCall`,
 * `judgeCall` and their types on `/eval`, and — the half that touches existing
 * names — `simulate`/`judge` on `EvalTestContext` and `EvalTextTestContext`,
 * `stubCaller`/`stubJudge` on `EvalCaseOptions`, and `callerLlm`/`judgeLlm` on
 * `DescribeEvalOptions` and `DescribeTextEvalOptions`.
 *
 * Every one of those is either a new export or an OPTIONAL field on an options
 * bag, or a member ADDED to a context the harness constructs and hands to a
 * case. What this file freezes is the three spellings an epoch-5 suite used for
 * those names, none of which may be broken by them having grown:
 *
 * - a case body declared on its own, typed against `EvalTestContext`, and
 *   destructuring only what epoch 5 had;
 * - an `EvalCaseOptions` literal and a `DescribeEvalOptions` literal held in
 *   variables, which an added optional field cannot redden;
 * - the same two for a TEXT suite;
 * - a `generate` double reporting through `onUsage` with the record typed by
 *   NAME — `StepUsage`, which epoch 5 is the first to publish.
 *
 * The direction that WOULD redden it is a case author CONSTRUCTING an
 * `EvalTestContext` by hand — a harness replaying case bodies outside
 * `describeEval`. That literal now lacks `simulate` and `judge`. It is not
 * frozen here because the context is the harness's to build and no shipped
 * template or documented pattern ever built one; if that turns out wrong, the
 * finding is an epoch-5 drop, not an edit to this file.
 *
 * **Its imports are RELATIVE**, for the reason `v4.ts` gives: the package's own
 * `exports` map would resolve to whatever the current build publishes.
 *
 * @module
 */

import { agent, tool } from "@alexkroman1/aai";
import { toolRegistry, withTools } from "@alexkroman1/aai/manifest";
import { z } from "zod";
import { errorsIn, type HostGenerateFn, type StepUsage, toolNames } from "../../../eval-barrel.ts";
import {
  type DescribeEvalOptions,
  type DescribeTextEvalOptions,
  describeEval,
  describeTextEval,
  type EvalCaseOptions,
  type EvalTestContext,
  type EvalTextTestContext,
} from "../../../eval-vitest-barrel.ts";

// ─── The agent under evaluation ──────────────────────────────────────────────
// EDIT POINT: in a real project this is `import agentDef from "./agent.ts"`.

const lookUp = tool({
  description: "Look up an order.",
  inputSchema: z.object({ id: z.string() }),
  execute: ({ id }) => `order ${id} shipped`,
});

const agentDef = withTools(
  agent({ name: "Order Desk", greeting: "Order desk." }),
  toolRegistry({ "tools/look_up.ts": { default: lookUp } }),
);

// ─── EDIT POINT: the suite and case options, held in variables ───────────────

/** What the suite adds up — typed by the name epoch 5 published. */
const spent: StepUsage[] = [];

const stubGenerate: HostGenerateFn = async (options, callOptions) => {
  const usage: StepUsage = { inputTokens: options.prompt.length, outputTokens: 4 };
  spent.push(usage);
  callOptions?.onUsage?.(usage);
  return { text: "a summary" };
};

const SUITE: DescribeEvalOptions = { env: {}, generate: stubGenerate };

const LOOKUP_CASE: EvalCaseOptions = {
  stubReply: [{ tool: "look_up", args: { id: "W1234" } }, "It shipped."],
};

// ─── EDIT POINT: a case body declared on its own ─────────────────────────────
//
// Typed against the context, destructuring only what epoch 5 handed a case.
// It throws rather than calling `expect`, which a linter only allows inside a
// `test()` call — a body declared on its own is exactly outside one.

async function looksUpTheOrder({ session, mode }: EvalTestContext): Promise<void> {
  const turn = await session.say("Has order W1234 shipped?");
  if (!toolNames(turn.toolCalls).includes("look_up")) {
    throw new Error(`did not look the order up: ${turn.text}`);
  }
  if (mode === "stub" && turn.text !== "It shipped.") throw new Error(turn.text);
  if (errorsIn(session.events()).length > 0) throw new Error("the session reported an error");
}

describeEval(
  agentDef,
  (test) => {
    test("looks the order up before answering", looksUpTheOrder, LOOKUP_CASE);
  },
  SUITE,
);

// ─── The same three spellings for a TEXT suite ───────────────────────────────

const textDef = agent({ name: "Order Chat", text: true });

const TEXT_SUITE: DescribeTextEvalOptions = { env: {} };

async function answers({ agent: chat }: EvalTextTestContext): Promise<void> {
  const turn = await chat.send("hello");
  if (!turn.completed) throw new Error("the reply did not complete");
}

describeTextEval(
  textDef,
  (test) => {
    test("answers", answers, { stubReply: "Hello." });
  },
  TEXT_SUITE,
);
