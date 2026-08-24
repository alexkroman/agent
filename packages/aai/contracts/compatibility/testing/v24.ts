// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:testing` epoch 24.
 *
 * **What is new: `stubDelegate`**, the fake for `ctx.delegate`. It is the same
 * seam as `stubGenerate` one loop up — a script keyed by the thing that tells
 * one call from another, which for a subagent is its NAME — and it exists for
 * the same reason: without it a spec of a delegating tool either runs a real
 * model or hand-writes a `DelegateFn`, and the hand-written one answers every
 * subagent identically, so a two-subagent tool can only be driven through one
 * arm. `createToolContext` defaults `delegate` to a rejection that names this
 * helper, so the failure is a sentence rather than a `TypeError`.
 *
 * Epoch 23 is RETAINED and `./v23.ts` compiles unchanged beside this file:
 * this epoch only ADDS names. Everything above `deskFixture` below is epoch
 * 23's, spelling for spelling.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative.
 */
import { z } from "zod";

import { subagent, tool } from "../../../index.ts";
import {
  createRunSnapshot,
  createToolContext,
  ok,
  runTool,
  type StubDelegate,
  type StubDelegateCall,
  type StubDelegateReply,
  type StubDelegateRoute,
  stubDelegate,
  type ToolRunner,
  toolRunner,
  withDiscoveredTools,
} from "../../../sdk/testing.ts";
import { type MockWorkflowsOptions, mockWorkflows } from "../../../sdk/testing-vitest.ts";

/** What `tools/price_cart.ts` default-exports. A spec imports the module itself. */
export const priceCart = tool({
  description: "Total the cart in the currency the caller asked for.",
  inputSchema: z.object({ currency: z.string() }),
  execute: async ({ currency }) => ({ currency, total: 250 }),
});

/** What `tools/view_order.ts` default-exports: a tool that takes no arguments. */
export const viewOrder = tool({
  description: "Read back the order as it stands.",
  execute: async (_args, ctx) => ({ session: ctx.sessionId }),
});

/** Unchanged from epoch 22: the def a DEPLOYED agent runs, tools discovered. */
export const wired = withDiscoveredTools(
  { label: "cart bench", tools: {} },
  {
    "./tools/price_cart.ts": { default: priceCart },
    "./tools/view_order.ts": { default: viewOrder },
  },
);

/**
 * New at epoch 23, and the line every template spec now opens with. One runner
 * per file, at module scope: it holds the agent and nothing else, so each call
 * still defaults to a FRESH context — a distinct session with empty slots.
 */
export const run: ToolRunner = toolRunner(wired);

/**
 * All three shapes through the bound runner, which is the property the ten
 * hand-written wrappers were forwarding by hand.
 *
 * The middle one is the shape a narrowed `(name, args)` wrapper gives up: the
 * context in the arguments' place, for a tool that takes none.
 */
export async function everyShape(): Promise<string> {
  const priced = ok<{ total: number }>(await run("price_cart", { currency: "usd" }));

  const ctx = createToolContext();
  const shared = ok<{ session: string }>(await run("view_order", ctx));
  const fresh = ok<{ session: string }>(await run("view_order"));

  return `${priced.total} ${shared.session} ${fresh.session}`;
}

/** Unchanged from epoch 22: the unbound form is still there, and still works. */
export async function unbound(): Promise<number> {
  return ok<{ total: number }>(
    await runTool(wired, "price_cart", { currency: "usd" }, createToolContext()),
  ).total;
}

/**
 * New at epoch 23: what a spec of a workflow-driving agent passes. `runs` is ONE
 * list — `get` answers with its first, `find` and `recent` with the whole thing
 * — because a spec asserting what a tool REPORTS is describing one world, and
 * three fixtures that can disagree about it is a way to write a passing test for
 * a state the platform cannot produce.
 */
export const workflowFixture: MockWorkflowsOptions = {
  names: ["recap"],
  runs: [createRunSnapshot({ workflow: "recap", status: "running" })],
  runId: "wrun_stub",
  lastLine: undefined,
};

/**
 * Referenced by TYPE. Calling it here would build spies outside a test; what the
 * epoch promises is the signature and that its result is a whole
 * `WorkflowClient`, spreadable to replace one method for one test.
 */
export const workflowsFactory: (options?: MockWorkflowsOptions) => unknown = mockWorkflows;

// ─── New at epoch 24 ─────────────────────────────────────────────────────────

const researcher = subagent({ name: "researcher", instructions: "Research it." });
const checker = subagent({ name: "fact-checker", instructions: "Check it." });

/** A route may be a fixed reply or a function of the call — both shapes here. */
const findings: StubDelegateReply = { text: "Two sources agree.", steps: 3 };
const perCall: StubDelegateRoute = (call: StubDelegateCall) => `Nothing on ${call.task}.`;

/**
 * The script, keyed by subagent name. A delegation to a subagent with no route
 * REJECTS naming it, which is what stops a spec driving a two-subagent tool
 * through one arm and calling it covered.
 */
export const deskFixture: StubDelegate = stubDelegate({
  researcher: findings,
  "fact-checker": perCall,
});

/** Passed as `delegate`, and read back for who was asked what. */
export async function delegated(): Promise<string> {
  const ctx = createToolContext({ delegate: deskFixture.delegate });
  const research = await ctx.delegate(researcher, { task: "battery prices" });
  const verdict = await ctx.delegate(checker, { task: "Prices fell.", context: "Be strict." });
  const asked = deskFixture.calls.map((call) => call.subagent.name).join(", ");
  return `${research.text} ${research.steps} ${verdict.text} (${asked})`;
}

/** One route answering every subagent — what a one-subagent tool's spec passes. */
export const singleRoute: StubDelegate = stubDelegate("Found it.");
