import type { ToolContext } from "@alexkroman1/aai";
import { describe, expect, test } from "vitest";
import retailAgent from "./agent.ts";
import { getState, isError } from "./store.ts";

/** Tools that legitimately run before the caller is identified. Everything
 *  else must refuse. Listed here so ADDING an unauthenticated tool is a
 *  deliberate edit to this file, not a silent gap. */
const PUBLIC_TOOLS = new Set([
  "find_user_id_by_email",
  "find_user_id_by_name_zip",
  "get_product_details",
  "get_item_details",
  "list_all_product_types",
  "transfer_to_human_agents",
]);

const registry = Object.entries(retailAgent.tools ?? {});

let sessionCounter = 0;
function makeCtx(): ToolContext {
  return {
    sessionId: `registry-test-${++sessionCounter}`,
    send: () => {},
    env: {},
    state: {},
    messages: [],
  } as unknown as ToolContext;
}

/** Minimal args satisfying each tool's schema. Deliberately plausible-shaped
 *  but wrong — these calls are expected to fail; what is asserted is that they
 *  still moved the UI. */
const SAMPLE_ARGS: Record<string, Record<string, unknown>> = {
  cancel_pending_order: { order_id: "#W0000000", reason: "no longer needed" },
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
  test("registers all fifteen tau2 retail tools", () => {
    expect(registry.map(([name]) => name).sort()).toEqual(
      [
        "cancel_pending_order",
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
    const ctx = makeCtx();
    const before = getState(ctx).callSeq;
    await def.execute(SAMPLE_ARGS[name] ?? {}, ctx);
    const state = getState(ctx);
    expect(state.callSeq, `${name} did not bump callSeq`).toBe(before + 1);
    expect(state.activity.at(-1)?.tool, `${name} logged the wrong tool name`).toBe(name);
    expect(state.activity.at(-1)?.summary).toBeTruthy();
  });

  test.each(registry)("%s logs its own registry key as its name", async (name, def) => {
    // Catches a copy-paste where the retailTool `name` and the registry key
    // disagree — the activity feed would then attribute calls to the wrong tool.
    const ctx = makeCtx();
    await def.execute(SAMPLE_ARGS[name] ?? {}, ctx);
    expect(getState(ctx).activity.at(-1)?.tool).toBe(name);
  });
});

describe("the authentication gate", () => {
  test.each(registry.filter(([name]) => !PUBLIC_TOOLS.has(name)))(
    "%s refuses before the caller is identified",
    async (name, def) => {
      const result = await def.execute(SAMPLE_ARGS[name] ?? {}, makeCtx());
      expect(isError(result), `${name} did not refuse`).toBe(true);
      if (!isError(result)) return;
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
      // an `if (isError(result))` wrapper would pass vacuously for the tools
      // that succeed, which is precisely the set most at risk of regressing.
      const blockedByGate = isError(result) && result.error.includes("find_user_id_by_email");
      expect(blockedByGate, `${name} was blocked by the auth gate`).toBe(false);
    },
  );
});

describe("agent config", () => {
  test("declares a syncState projection — without it the UI never updates", () => {
    expect(typeof retailAgent.syncState).toBe("function");
  });

  test("declares a state factory, so sessions do not share a store", () => {
    expect(typeof retailAgent.state).toBe("function");
    const a = retailAgent.state?.();
    const b = retailAgent.state?.();
    expect(a).not.toBe(b);
  });
});
