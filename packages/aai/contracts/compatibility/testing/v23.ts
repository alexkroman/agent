// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:testing` epoch 23.
 *
 * **Epoch 23 is ADDITIONS ONLY** — `toolRunner`/`ToolRunner` on
 * `@alexkroman1/aai/testing`, `mockWorkflows`/`MockWorkflowsOptions` on its
 * `/vitest` half. Nothing was removed and no signature narrowed, so epoch 22 is
 * RETAINED and `./v22.ts` compiles unchanged beside this file, as do every other
 * epoch it left standing.
 *
 * Both come out of the same finding, one epoch on from the three families 22
 * added: a helper every project re-derives is part of this API whether or not it
 * is exported.
 *
 * - **`toolRunner(agent)` is `runTool` with the agent bound**, and `runTool`'s
 *   own documentation already named that wrapper as how every template reached
 *   it — ten of them, six with the union in the second position spelled out
 *   verbatim. The union is what is worth removing rather than the line: a spec
 *   that writes the signature has to restate
 *   `Record<string, unknown> | ToolContext` to forward both of `runTool`'s
 *   shapes, and a spec that narrows it to `(name, args)` has quietly given up
 *   the second one. Four had; three of those then passed `{}` by hand for the
 *   no-argument tools the shorthand exists for.
 * - **`mockWorkflows(options)` is `createStubWorkflows` with the reads answered
 *   from one fixture**, every method a `vi.fn`. The rejecting base is the right
 *   default and it is not the shape a spec of a workflow-driving agent wants,
 *   because such a tool reads two or three methods per call and asserts on
 *   `start`. Both shipped workflow templates opened with the same fifteen lines,
 *   byte-identical apart from the workflow name in `listing`.
 *
 * **Why they are on different subpaths is the rule rather than an accident.**
 * `toolRunner` closes over nothing but the agent, so it stays framework-agnostic
 * beside `runTool`. `mockWorkflows` has to hand back spies — a spec asserts
 * `toHaveBeenCalledWith` on `start` and re-points `lastLine` per test — so
 * `vi.fn` IS its content, and that belongs on the subpath whose `vitest` peer is
 * what pulls the runner. It takes no `install` prefix, because it installs
 * nothing and restores nothing.
 *
 * The names imported for their TYPES only are not called here: this file is
 * compiled, never run, and `mockWorkflows` outside a test would build spies with
 * no test to attach assertions to.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative.
 */

import { z } from "zod";

import { tool } from "../../../index.ts";
import {
  createRunSnapshot,
  createToolContext,
  ok,
  runTool,
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
