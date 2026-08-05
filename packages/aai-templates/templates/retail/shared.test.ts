import { describe, expect, test } from "vitest";
import seedJson from "./seed.json";
import type { RetailState, Store } from "./shared.ts";
import { buildScriptBullets, DEMO_PERSONAS, storeView } from "./shared.ts";

function makeState(authenticatedUserId: string | null): RetailState {
  return {
    store: structuredClone(seedJson) as unknown as Store,
    authenticatedUserId,
    callSeq: 3,
    activity: [{ seq: 3, tool: "get_order_details", summary: "read #W5866402", at: 0 }],
    focus: { orderId: "#W5866402" },
  };
}

describe("storeView", () => {
  test("projects nothing identifying before authentication", () => {
    const view = storeView({ retail: makeState(null) });
    expect(view.customer).toBeNull();
    expect(view.orders).toEqual([]);
  });

  test("an absent state slot degrades to an empty view", () => {
    const view = storeView({});
    expect(view.customer).toBeNull();
    expect(view.orders).toEqual([]);
    expect(view.callSeq).toBe(0);
  });

  test("projects the authenticated customer and only their orders", () => {
    const view = storeView({ retail: makeState("olivia_ito_3591") });
    expect(view.customer?.name).toBe("Olivia Ito");
    expect(view.customer?.email).toBe("olivia.ito5204@example.com");
    expect(view.orders.map((o) => o.orderId).sort((a, b) => a.localeCompare(b))).toEqual(
      ["#W3657213", "#W5353646", "#W5442520", "#W5866402", "#W7941031"].sort((a, b) =>
        a.localeCompare(b),
      ),
    );
  });

  test("projects live gift-card balances, since refunds move them", () => {
    const state = makeState("olivia_ito_3591");
    const view = storeView({ retail: state });
    const card = view.customer?.paymentMethods.find((m) => m.id === "gift_card_7794233");
    expect(card?.balance).toBe(56);
  });

  test("no other customer's email, address, or payment method reaches the client", () => {
    const view = storeView({ retail: makeState("olivia_ito_3591") });
    const json = JSON.stringify(view);
    for (const leaked of [
      "aarav.anderson9752@example.com",
      "harper.brown3965@example.com",
      "emma.smith3991@example.com",
      "gift_card_7245904",
      "paypal_2306935",
      "#W4316152",
      "#W1840144",
    ]) {
      // Soft: a widened projection leaks several fields at once, and the full
      // list is what says how much of the other customers' records got out.
      expect.soft(json, `projection leaked ${leaked}`).not.toContain(leaked);
    }
  });

  test("carries callSeq, activity and focus through", () => {
    const view = storeView({ retail: makeState("olivia_ito_3591") });
    expect(view.callSeq).toBe(3);
    expect(view.activity).toHaveLength(1);
    expect(view.focus.orderId).toBe("#W5866402");
  });

  test("order totals sum the payments, not the items", () => {
    const view = storeView({ retail: makeState("olivia_ito_3591") });
    const delivered = view.orders.find((o) => o.orderId === "#W5866402");
    expect(delivered?.total).toBe(3203.78);
  });
});

describe("DEMO_PERSONAS", () => {
  test("lists every seeded customer", () => {
    expect(DEMO_PERSONAS).toHaveLength(Object.keys(seedJson.users).length);
  });

  test("every persona's email, name and zip match its seed record", () => {
    const users = Object.values((structuredClone(seedJson) as unknown as Store).users);
    for (const persona of DEMO_PERSONAS) {
      const user = users.find((u) => u.email === persona.email);
      expect.soft(user, `no seeded customer has email ${persona.email}`).toBeDefined();
      expect
        .soft(`${user?.name.first_name} ${user?.name.last_name}`, persona.email)
        .toBe(persona.name);
      expect.soft(user?.address.zip, persona.email).toBe(persona.zip);
    }
  });

  test("every persona carries a hint, so a user can pick a path deliberately", () => {
    for (const persona of DEMO_PERSONAS) {
      expect.soft(persona.hint.length, persona.name).toBeGreaterThan(20);
    }
  });
});

describe("swapOptions", () => {
  test("empty when no order is focused", () => {
    const state = makeState("olivia_ito_3591");
    state.focus = {};
    expect(storeView({ retail: state }).swapOptions).toEqual([]);
  });

  test("lists available alternatives for the focused order's items", () => {
    // makeState focuses #W5866402 — Espresso Machine + Sneakers.
    const view = storeView({ retail: makeState("olivia_ito_3591") });
    expect(view.swapOptions).toHaveLength(2);
    const espresso = view.swapOptions.find((s) => s.itemId === "6242772310");
    expect(espresso?.itemName).toBe("Espresso Machine");
    expect(espresso?.alternatives.length).toBeGreaterThan(0);
    expect(espresso?.alternatives.map((a) => a.itemId)).not.toContain("6242772310");
  });

  test("never offers an unavailable variant as a target", () => {
    const state = makeState("aarav_anderson_8794");
    state.focus = { orderId: "#W4316152" };
    const view = storeView({ retail: state });
    const ids = view.swapOptions.flatMap((s) => s.alternatives.map((a) => a.itemId));
    // 6454334990 is a Tea Kettle variant with available: false.
    expect(ids).not.toContain("6454334990");
  });

  test("caps both axes so the payload stays bounded", () => {
    const state = makeState("aarav_anderson_8794");
    state.focus = { orderId: "#W9311069" }; // five items
    const view = storeView({ retail: state });
    expect(view.swapOptions.length).toBeLessThanOrEqual(3);
    for (const option of view.swapOptions) {
      expect(option.alternatives.length).toBeLessThanOrEqual(4);
    }
  });

  test("a focus on another customer's order projects nothing", () => {
    const state = makeState("olivia_ito_3591");
    state.focus = { orderId: "#W4316152" }; // aarav's
    const view = storeView({ retail: state });
    expect(view.swapOptions).toEqual([]);
    expect(JSON.stringify(view)).not.toContain("#W4316152");
  });
});

describe("buildScriptBullets", () => {
  test("pre-auth bullets name both lookup paths using the first persona", () => {
    const bullets = buildScriptBullets(makeState(null));
    expect(bullets.join(" ")).toContain(DEMO_PERSONAS[0]?.email ?? "");
    expect(bullets.join(" ")).toContain(DEMO_PERSONAS[0]?.zip ?? "");
  });

  test("undefined state yields the pre-auth bullets", () => {
    expect(buildScriptBullets(undefined).length).toBeGreaterThan(0);
  });

  test("a customer with pending orders is offered cancel and address change", () => {
    const bullets = buildScriptBullets(makeState("olivia_ito_3591")).join(" ").toLowerCase();
    expect(bullets).toContain("cancel");
    expect(bullets).toContain("address");
  });

  test("a customer with a delivered order is offered a return naming a real item", () => {
    const bullets = buildScriptBullets(makeState("olivia_ito_3591")).join(" ");
    expect(bullets.toLowerCase()).toContain("return");
    expect(bullets).toMatch(/Espresso Machine|Sneakers/);
  });

  test("the exchange bullet names a real alternative option, not 'a different option'", () => {
    const state = makeState("olivia_ito_3591");
    const bullets = buildScriptBullets(state);
    const exchange = bullets.find((b) => b.toLowerCase().includes("exchange"));
    expect(exchange).toBeDefined();
    // It must quote option values that really exist on that product.
    const espresso = state.store.products["4354588079"];
    const optionWords = Object.values(espresso?.variants ?? {})
      .filter((v) => v.available)
      .flatMap((v) => Object.values(v.options));
    expect(optionWords.some((word) => exchange?.includes(word))).toBe(true);
  });

  test("no return bullet when the customer has no delivered order", () => {
    // anya_garcia_3271 has cancelled + processed + pending, no delivered.
    const bullets = buildScriptBullets(makeState("anya_garcia_3271")).join(" ").toLowerCase();
    expect(bullets).not.toContain("return");
    expect(bullets).not.toContain("exchange");
  });

  test("bullets stay short enough to render in a sidebar", () => {
    const bullets = buildScriptBullets(makeState("olivia_ito_3591"));
    expect(bullets.length).toBeLessThanOrEqual(6);
  });
});
