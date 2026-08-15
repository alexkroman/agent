// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:testing` epoch 13.
 *
 * **This epoch moved for a TRANSITIVE reason, and that is worth recording rather
 * than smoothing over.** Nothing on `/testing` was added, removed or renamed —
 * the export list is identical to epoch 12's. What changed is `AgentDef`, which
 * gained the `events` field of `aai:agent` epoch 11, and `withDiscoveredTools`
 * mentions `AgentDef` in its signature. A capability's hash covers the shape a
 * consumer has to satisfy, so a type reachable FROM the surface is part of it;
 * that is the same reason `includeForgottenExports` is on.
 *
 * So the honest example is epoch 12's, still compiling — a spec arranges through
 * the slot, acts through the tool, and asserts through the slot, and each
 * `createToolContext()` is a distinct session. Epoch 12 is RETAINED for exactly
 * that reason, and `./v12.ts` compiles unchanged beside this file.
 *
 * What is new here is the one thing this epoch's own change makes testable: a def
 * carrying `events` still reaches a spec through `withDiscoveredTools`, so a
 * project whose tools are FILES can assert against the def a DEPLOYED agent runs.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative.
 */

import { agent, sessionSlot } from "../../../index.ts";
import { createToolContext, withDiscoveredTools } from "../../../sdk/testing.ts";

const cartSlot = sessionSlot("cart", () => ({ items: [] as string[] }));

const addItem = cartSlot.updateTool({
  description: "Add an item.",
  execute: (_args, cart) => {
    cart.items.push("apple");
    return { count: cart.items.length };
  },
});

/** Arrange through the slot, act through the tool, assert through the slot. */
export function addsToASeededCart(): number {
  const ctx = createToolContext({ sessionId: "spec-1" });
  cartSlot.update(ctx, (cart) => cart.items.push("pear"));
  void addItem.execute({}, ctx);
  return cartSlot.get(ctx).items.length;
}

/** Two contexts are two sessions, so their slots are independent. */
export function isolatedBySession(): boolean {
  const a = createToolContext();
  const b = createToolContext();
  cartSlot.update(a, (cart) => cart.items.push("apple"));
  return cartSlot.get(b).items.length === 0;
}

/**
 * The def a DEPLOYED agent runs, assembled the way a spec has to assemble it: a
 * `tools/` file is the tool, so `agent()`'s own export carries only the inline
 * ones and the discovery glob supplies the rest. An `events` handler rides along
 * on the same def, which is the shape this epoch introduced.
 */
const observed = agent({
  name: "Observed",
  events: { "tool.called": (event) => void event.toolName },
});

export function defWithDiscoveredTools(): string {
  // A spec passes `import.meta.glob`'s RESULT; an empty record is the legal
  // degenerate case and is what keeps this example free of a fixture directory.
  return withDiscoveredTools(observed, {}).name;
}
