// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `testing` epoch 11.
 *
 * Epoch 11 added `withDiscoveredTools` — the def a DEPLOYED agent runs, for a
 * spec whose project keeps its tools in `tools/` files rather than inline. It is
 * the one thing on this capability that a spec CANNOT do without: `agent.ts`'s
 * default export carries only the inline tools, so before this every such spec
 * either reached for a monorepo-internal helper (which is what five shipped
 * templates did, and it does not exist in a scaffolded project) or drove the tool
 * modules directly and never checked the name the model calls.
 *
 * Everything epoch 10 could express still compiles (see `./v10.ts`, retained for
 * that reason); this file covers only what is new.
 *
 * See `../agent/v1.ts` for what "frozen" obliges and why the imports are
 * relative. **`import.meta.glob` is deliberately not called here** — it is a
 * Vite transform, and a compatibility fixture is compiled by `tsc`, not bundled,
 * so the glob's own shape is pinned as the `ToolModules` argument type instead
 * (a plain `path → module` record, which is exactly what an eager glob returns).
 */

import { createToolContext, runTool, withDiscoveredTools } from "../../../sdk/testing.ts";
import type { ToolModules } from "../../../sdk/tool-registry.ts";
import type { AgentDef } from "../../../sdk/types.ts";

type CartState = { items: string[] };

const authored: AgentDef<CartState> = {
  name: "Cart",
  systemPrompt: "Take orders.",
  greeting: "Hi.",
  maxSteps: 10,
  tools: {},
  state: () => ({ items: [] }),
};

// What `import.meta.glob("./tools/*.ts", { eager: true })` evaluates to in a
// user's project: one entry per file, each the module namespace.
const discovered: ToolModules = {
  "./tools/add_item.ts": {
    default: {
      description: "Add an item to the cart.",
      execute: (_args: unknown, ctx: { state: CartState }) => {
        ctx.state.items.push("apple");
        return { added: "apple" };
      },
    },
  },
};

const agentDef = withDiscoveredTools(authored, discovered);

export async function addsAnItem(): Promise<unknown> {
  const ctx = createToolContext<CartState>({ state: { items: [] } });
  return await runTool(agentDef, "add_item", {}, ctx);
}

// The registry is on the returned def, under the name the model calls — which is
// the whole point of resolving it in a spec rather than importing the module.
export const declaresAddItem: boolean = agentDef.tools.add_item !== undefined;
