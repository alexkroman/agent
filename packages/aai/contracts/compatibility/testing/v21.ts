// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:testing` epoch 21.
 *
 * The export list is identical to epoch 20's, so this is a SIGNATURE change and
 * epoch 20 is RETAINED — `./v20.ts` compiles unchanged beside this file, and
 * every call written against it still infers `AgentDef` in and `AgentDef` out.
 *
 * What moved is that `withDiscoveredTools` is **structural** now, the way
 * `toolOf` and `runTool` have been all along:
 *
 * ```ts no-check
 * // epoch 20
 * withDiscoveredTools(def: AgentDef, modules: ToolModules): AgentDef
 * // epoch 21
 * withDiscoveredTools<D extends ToolBearingAgent>(def: D, modules: ToolModules): D
 * ```
 *
 * The parameter widens and the return narrows, which is why nothing had to
 * change at a call site. What it buys a SPEC is the same thing `ToolBearingAgent`
 * was introduced for: the def a spec drives need not be an `AgentDef` at all, and
 * whatever it does carry comes back out still typed.
 *
 * **The reason it is worth an epoch is what it took OFF this contract.** A
 * mention is part of a capability's shape, so naming `AgentDef` in one signature
 * pulled `AgentDef -> events -> SessionEventHandlers -> SessionEvent ->
 * SessionEventSchema` into the `/testing` report — a zod discriminated union, and
 * the only reason `zod` appeared in it — along with `PipelineVoiceTuning`,
 * `BuiltinTool`, `ToolChoice`, `StateProjection` and all four provider types.
 * Sixteen declarations and roughly 250 lines, none of them nameable by a spec
 * author, and each one a way for this capability to move for a reason that has
 * nothing to do with testing: epochs 13 and 20 both say so in their own text.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative.
 */

import { z } from "zod";

import { tool } from "../../../index.ts";
import {
  createToolContext,
  runTool,
  type ToolBearingAgent,
  toolOf,
  withDiscoveredTools,
} from "../../../sdk/testing.ts";

/** What `tools/price_cart.ts` default-exports. A spec imports the module itself. */
export const priceCart = tool({
  description: "Total the cart in the currency the caller asked for.",
  inputSchema: z.object({ currency: z.string() }),
  execute: async ({ currency }) => ({ currency, total: 250 }),
});

/**
 * A harness a spec builds for itself, which is what epoch 21 makes reachable.
 *
 * Not an `AgentDef` — it declares no name, no greeting and no providers, and it
 * carries a field of its own. Epoch 20 refused it: `AgentDef` in the parameter
 * position made the missing fields an error and the extra one excess.
 */
const bench = { label: "cart bench", tools: {} } satisfies ToolBearingAgent & { label: string };

/**
 * The def under test. A real spec passes
 * `import.meta.glob("./tools/*.ts", { eager: true })`, which needs the project's
 * own vite/client types — the glob's RESULT is `path → module`, so a literal is
 * the same shape and is what keeps this example free of a fixture directory.
 */
const wired = withDiscoveredTools(bench, { "./tools/price_cart.ts": { default: priceCart } });

/**
 * The return NARROWS, which is the half a call site can observe: `wired` is the
 * bench's own type, so its `label` is still there and still a `string`. Under
 * epoch 20 this line did not compile, because the answer was an `AgentDef`.
 */
export function theHarnessKeepsItsOwnFields(): string {
  return wired.label;
}

/** Reaching the def by name: what a spec asserts when the SUBJECT is the wiring. */
export function priceCartIsDeclared(): string {
  return toolOf(wired, "price_cart").description;
}

/**
 * Driving it by name. `runTool` answers `Promise<unknown>` — the lookup is by a
 * runtime string — and epoch 21 does not change that; see `./v20.ts` for why a
 * signature claiming otherwise would have to be a lie somewhere.
 */
export async function pricesTheCart(): Promise<boolean> {
  const ctx = createToolContext({ env: { CURRENCY: "usd" } });
  const actual: unknown = await runTool(wired, "price_cart", { currency: "usd" }, ctx);
  return JSON.stringify(actual) === JSON.stringify({ currency: "usd", total: 250 });
}
