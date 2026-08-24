/// <reference types="vite/client" />

import { isToolFailure, type ToolContext } from "@alexkroman1/aai";
import { createToolContext, withDiscoveredTools } from "@alexkroman1/aai/testing";
import { describe, expect, test } from "vitest";
import authoredAgent from "./agent.ts";
import { callFlow, retailSlot } from "./store.ts";

/** Tools that legitimately run before the caller is identified — the six
 *  declaring `when: BEFORE_TRANSFER`. Everything else must refuse. Listed here
 *  so ADDING an unauthenticated tool is a deliberate edit to this file, not a
 *  silent gap. */
const PUBLIC_TOOLS = new Set([
  "find_user_id_by_email",
  "find_user_id_by_name_zip",
  "get_product_details",
  "get_item_details",
  "list_all_product_types",
  "transfer_to_human_agents",
]);

/**
 * The def a DEPLOYED agent runs: authored, plus what `tools/` declares.
 *
 * The glob is written HERE rather than reached for from a shared helper because
 * this file SHIPS: it is what a scaffolded project runs, so it may not import
 * anything outside its own template, and `import.meta.glob` is expanded against
 * the file containing it either way. This is the pattern a user writes.
 */
const retailAgent = withDiscoveredTools(
  authoredAgent,
  import.meta.glob("./tools/*.ts", { eager: true }),
);
const registry = Object.entries(retailAgent.tools);

// `createToolContext()` rather than a cast: it carries a real slot store (the
// same storability check and freeze the deployed one applies), and each call is a
// distinct session, which is what these per-tool cases assume.
const makeCtx = (): ToolContext => createToolContext();

/** A context whose call flow is in `serving.helping`, so a `when: "serving"`
 *  tool can reach its body. Moved through the FLOW rather than by writing
 *  `authenticatedUserId`, because the gate reads the machine. */
function servingCtx(): ToolContext {
  const ctx = makeCtx();
  callFlow.send(ctx, { type: "IDENTIFIED" });
  return ctx;
}

/** The two tools legal only while a change waits on the caller's yes. */
const SETTLING_TOOLS = new Set(["cancel_change", "confirm_change"]);

function toolNamed(name: string) {
  const def = retailAgent.tools[name];
  if (!def) throw new Error(`no tool named ${name}`);
  return def;
}

/**
 * A context in whatever state `name` needs to reach its BODY.
 *
 * The two settling tools are reached by really identifying a caller and really
 * staging a change, rather than by sending `STAGED` at the machine: they read
 * `state.pending`, and a position with nothing staged behind it is a state this
 * template cannot actually be in. Everything else only needs `serving`.
 */
async function bodyReachableCtx(name: string): Promise<ToolContext> {
  if (!SETTLING_TOOLS.has(name)) return servingCtx();
  const ctx = makeCtx();
  await toolNamed("find_user_id_by_email").execute(
    { email: "aarav.anderson9752@example.com" },
    ctx,
  );
  await toolNamed("cancel_pending_order").execute(
    { order_id: "#W9300146", reason: "no longer needed" },
    ctx,
  );
  return ctx;
}

/** Minimal args satisfying each tool's schema. Deliberately plausible-shaped
 *  but wrong — these calls are expected to fail; what is asserted is that they
 *  still moved the UI. */
const SAMPLE_ARGS: Record<string, Record<string, unknown>> = {
  cancel_change: {},
  cancel_pending_order: { order_id: "#W0000000", reason: "no longer needed" },
  confirm_change: {},
  exchange_delivered_order_items: {
    order_id: "#W0000000",
    item_ids: ["0000000000"],
    new_item_ids: ["1111111111"],
    payment_method_id: "gift_card_0000000",
  },
  find_user_id_by_email: { email: "nobody@example.com" },
  find_user_id_by_name_zip: { first_name: "No", last_name: "Body", zip: "00000" },
  get_item_details: { item_id: "0000000000" },
  get_order_details: { order_id: "#W0000000" },
  get_product_details: { product_id: "0000000000" },
  get_user_details: { user_id: "nobody_0" },
  list_all_product_types: {},
  modify_pending_order_address: {
    order_id: "#W0000000",
    address1: "1 A St",
    address2: "",
    city: "Springfield",
    state: "OR",
    country: "USA",
    zip: "97477",
  },
  modify_pending_order_items: {
    order_id: "#W0000000",
    item_ids: ["0000000000"],
    new_item_ids: ["1111111111"],
    payment_method_id: "gift_card_0000000",
  },
  modify_pending_order_payment: {
    order_id: "#W0000000",
    payment_method_id: "gift_card_0000000",
  },
  modify_user_address: {
    user_id: "nobody_0",
    address1: "1 A St",
    address2: "",
    city: "Springfield",
    state: "OR",
    country: "USA",
    zip: "97477",
  },
  return_delivered_order_items: {
    order_id: "#W0000000",
    item_ids: ["0000000000"],
    payment_method_id: "gift_card_0000000",
  },
  transfer_to_human_agents: { summary: "test" },
};

describe("tool registry", () => {
  test("registers all seventeen tools", () => {
    // Fifteen of these are tau2's retail tool set, which this template used to
    // hold verbatim. `confirm_change` and `cancel_change` are the two it does
    // not have: tau2's tools apply on their first call, and here nothing does —
    // see `pending.ts`. Departing from that set is what buys the confirmation
    // gate, and it is the reason this list is no longer a fidelity claim.
    expect(registry.map(([name]) => name).sort()).toEqual(
      [
        "cancel_change",
        "cancel_pending_order",
        "confirm_change",
        "exchange_delivered_order_items",
        "find_user_id_by_email",
        "find_user_id_by_name_zip",
        "get_item_details",
        "get_order_details",
        "get_product_details",
        "get_user_details",
        "list_all_product_types",
        "modify_pending_order_address",
        "modify_pending_order_items",
        "modify_pending_order_payment",
        "modify_user_address",
        "return_delivered_order_items",
        "transfer_to_human_agents",
      ].sort(),
    );
  });

  // Both sweep the registry, so they assert softly: adding a batch of tools
  // should list every one still missing its entry, not just the first.
  test("every registered tool has sample args, so the sweeps below cover it", () => {
    for (const [name] of registry) {
      expect.soft(SAMPLE_ARGS[name], `add SAMPLE_ARGS["${name}"]`).toBeDefined();
    }
  });

  test("every tool declares a description the model can act on", () => {
    for (const [name, def] of registry) {
      expect.soft(def.description, name).toBeTruthy();
      expect.soft(def.description.length, name).toBeGreaterThan(40);
    }
  });
});

describe("the UI-update invariant", () => {
  // This is the one that fails if a future tool is built with tool() instead of
  // retailTool(): it would work, and the sidebar would sit still through it.
  test.each(registry)("%s increments callSeq and logs activity", async (name, def) => {
    // In whichever state lets the body run, so the flow gate is not what these
    // calls are testing: the point is that a tool which reaches its BODY moves
    // the sidebar. A refused call deliberately does not — see `store.test.ts`.
    const ctx = await bodyReachableCtx(name);
    const before = retailSlot.get(ctx).callSeq;
    await def.execute(SAMPLE_ARGS[name] ?? {}, ctx);
    const state = retailSlot.get(ctx);
    expect(state.callSeq, `${name} did not bump callSeq`).toBe(before + 1);
    expect(state.activity.at(-1)?.tool, `${name} logged the wrong tool name`).toBe(name);
    expect(state.activity.at(-1)?.summary).toBeTruthy();
  });

  test.each(registry)("%s logs its own registry key as its name", async (name, def) => {
    // Catches a copy-paste where the retailTool `name` and the registry key
    // disagree — the activity feed would then attribute calls to the wrong tool.
    const ctx = await bodyReachableCtx(name);
    await def.execute(SAMPLE_ARGS[name] ?? {}, ctx);
    expect(retailSlot.get(ctx).activity.at(-1)?.tool).toBe(name);
  });
});

describe("the authentication gate", () => {
  test.each(registry.filter(([name]) => !PUBLIC_TOOLS.has(name)))(
    "%s refuses before the caller is identified",
    async (name, def) => {
      const result = await def.execute(SAMPLE_ARGS[name] ?? {}, makeCtx());
      expect(isToolFailure(result), `${name} did not refuse`).toBe(true);
      if (!isToolFailure(result)) return;
      // The refusal is `callFlow`'s: it names the position, and quotes the
      // state's instruction — which names the two tools that get out of it.
      expect(result.error, `${name} refused without naming the position`).toContain(
        '"identifying"',
      );
      expect(result.error, `${name} refused for the wrong reason`).toContain(
        "find_user_id_by_email",
      );
    },
  );

  test.each(registry.filter(([name]) => PUBLIC_TOOLS.has(name)))(
    "%s does not require authentication",
    async (name, def) => {
      const result = await def.execute(SAMPLE_ARGS[name] ?? {}, makeCtx());
      // A public tool may still fail on its own (deliberately bogus) arguments;
      // it must not fail on the GATE. Written as one unconditional assertion —
      // an `if (isToolFailure(result))` wrapper would pass vacuously for the tools
      // that succeed, which is precisely the set most at risk of regressing.
      const blockedByGate = isToolFailure(result) && result.error.includes("find_user_id_by_email");
      expect(blockedByGate, `${name} was blocked by the auth gate`).toBe(false);
    },
  );
});

describe("agent config", () => {
  test("declares a syncState projection — without it the UI never updates", () => {
    expect(typeof retailAgent.syncState).toBe("function");
  });

  // The slot owns the default now — there is no `state` factory on the agent to
  // forget to declare, which is what four of five slot-backed templates used to.
  // What still has to hold is that the factory really is called per session: the
  // 107 KB seed is one module-level object, so a shared clone would let one
  // caller's cancellation show up in another's.
  test("the slot's factory clones the seed, so sessions do not share a store", () => {
    const a = retailSlot.create();
    const b = retailSlot.create();
    expect(a).not.toBe(b);
    expect(a.store.orders).not.toBe(b.store.orders);
    expect(a.store).toEqual(b.store);
  });
});

describe("the transfer is terminal", () => {
  test.each(registry)("%s refuses once the call is with a human", async (name, def) => {
    const ctx = servingCtx();
    callFlow.send(ctx, { type: "TRANSFERRED" });

    const result = await def.execute(SAMPLE_ARGS[name] ?? {}, ctx);
    // EVERY tool, the six public ones and `transfer_to_human_agents` itself
    // included: nothing declares itself legal in the final state. Before the
    // flow, the policy's "say nothing else after that" was enforced by nothing.
    expect(isToolFailure(result), `${name} still ran after the handoff`).toBe(true);
    expect(isToolFailure(result) && result.error, name).toContain('"transferred"');
  });
});
