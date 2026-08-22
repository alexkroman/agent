// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:testing` epoch 20.
 *
 * **Moved for a TRANSITIVE reason**, the same shape as epoch 13's. The export
 * list is identical to epoch 19's and nothing on `/testing` was added, removed
 * or renamed. What changed is `ToolDef`, which grew a result type parameter at
 * `aai:tool` epoch 10 (see `../tool/v10.ts`) — and this capability mentions it
 * three times over: `ToolBearingAgent.tools` is a record of them, `toolOf`
 * returns one, and `withDiscoveredTools` takes and returns an `AgentDef` whose
 * `tools` field is another. Epoch 19 is RETAINED and `./v19.ts` compiles
 * unchanged beside this file.
 *
 * The reason it is worth a file rather than a footnote is that the new parameter
 * stops exactly here, and the boundary is a real one rather than an omission.
 * **These helpers find a tool by the NAME the model calls it by, and a name is a
 * runtime string** — `runTool(def, "price_cart", …)` cannot know which tool it
 * landed on, so it answers `Promise<unknown>` and always will. That is the right
 * answer: a signature claiming otherwise would have to be a lie somewhere.
 *
 * So a spec gets its types from the two ends and not from the middle:
 *
 * - **The ARRANGE and ASSERT ends are typed**, because the spec imports the
 *   tool's own module. `InferToolOutput<typeof priceCart>` is what checks the
 *   expected literal, and it resolves now where it was `unknown` before epoch 10
 *   — so a spec whose expectation drifted from the tool's real shape fails at
 *   `tsc` rather than at `toEqual`.
 * - **The ACT end goes through the name**, because that is the thing worth
 *   testing: not "does this function work" but "is this tool reachable under the
 *   name the model calls, on the def a DEPLOYED agent runs".
 *
 * And that def is not the one `agent.ts` exports. **A tool is a FILE** — the
 * table is filled by the build from `tools/*.ts` — so `agent()` carries none of
 * them and refuses a `tools` key outright, in the type AND at run time.
 * `withDiscoveredTools` is what closes the gap; handing `toolOf` the authored def
 * instead is the common mistake, and epoch 20 is where its error learned to say
 * so rather than printing a bare "(none)".
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative.
 */

import { z } from "zod";

import { agent, type InferToolOutput, tool } from "../../../index.ts";
import { createToolContext, runTool, toolOf, withDiscoveredTools } from "../../../sdk/testing.ts";

/** What `tools/price_cart.ts` default-exports. A spec imports the module itself. */
export const priceCart = tool({
  description: "Total the cart in the currency the caller asked for.",
  inputSchema: z.object({ currency: z.string() }),
  execute: async ({ currency }) => ({ currency, total: 250 }),
});

/** What `agent.ts` default-exports: a declaration, with no tool table in it. */
const authored = agent({ name: "Shop", greeting: "What are we buying?" });

/**
 * The def a DEPLOYED agent runs. A real spec passes
 * `import.meta.glob("./tools/*.ts", { eager: true })`, which needs the project's
 * own vite/client types — the glob's RESULT is `path → module`, so a literal is
 * the same shape and is what keeps this example free of a fixture directory.
 */
const deployed = withDiscoveredTools(authored, {
  "./tools/price_cart.ts": { default: priceCart },
});

/** The trap the epoch's error message names, stated as a fact about the def. */
export function authoredCarriesNoTools(): boolean {
  return Object.keys(authored.tools).length === 0 && Object.keys(deployed.tools).length === 1;
}

/** Reaching the def by name: what a spec asserts when the SUBJECT is the wiring. */
export function priceCartIsDeclared(): string {
  return toolOf(deployed, "price_cart").description;
}

/**
 * Driving it by name, and where the type comes from.
 *
 * `runTool` answers `Promise<unknown>` — the lookup is by string — so the
 * expectation is what carries the type, imported from the tool's own module. A
 * field renamed in `priceCart` fails this file at compile time; before epoch 10
 * `InferToolOutput` was `unknown` and the same rename failed nothing until the
 * assertion ran.
 */
export async function pricesTheCart(): Promise<boolean> {
  const ctx = createToolContext({ env: { CURRENCY: "usd" } });
  const actual: unknown = await runTool(deployed, "price_cart", { currency: "usd" }, ctx);
  const expected: InferToolOutput<typeof priceCart> = { currency: "usd", total: 250 };
  return JSON.stringify(actual) === JSON.stringify(expected);
}

/**
 * The other half `createToolContext` still guarantees, unchanged: each call is a
 * DISTINCT session, so two contexts never share slot values and a spec never has
 * to reset anything between cases.
 */
export function contextsAreDistinctSessions(): boolean {
  const first = createToolContext();
  const second = createToolContext();
  return first.sessionId !== second.sessionId;
}
