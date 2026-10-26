import { isToolFailure } from "@alexkroman1/aai";
import {
  createToolContext,
  deployedAgent,
  dialogRefusalPattern,
  expectDialogRefused,
  expectSlotContract,
  fireEvent,
  sessionEvent,
  type TestToolContext,
  toolInputIssues,
  toolOf,
  toolRunner,
} from "@alexkroman1/aai-runtime/testing";
import { describe, expect, test } from "vitest";
/**
 * The def a DEPLOYED agent runs, lowered BY HAND — the one place in the
 * templates that still does.
 *
 * `virtual:aai/agent` is what every other spec imports and what a user should
 * reach for. This file is the exception on purpose: its whole subject is the
 * tool REGISTRY, so doing the discovery explicitly is the thing under test
 * rather than setup around it. It is also the worked example for a project
 * whose runner is not vitest, and so cannot register the plugin.
 */
import authoredAgent from "./agent.ts";
import { callFlow, retailSlot } from "./store.ts";
import systemPrompt from "./system-prompt.md?raw";
import getUserDetails from "./tools/get_user_details.ts";

const retailAgent = deployedAgent(authoredAgent, {
  tools: import.meta.glob("./tools/*.ts", { eager: true }),
  systemPrompt,
});

const registry = Object.entries(retailAgent.tools);

/** The CALL, gated by the toolset exactly as the runtime gates it, reached by the def. */
const run = toolRunner(retailAgent);

/** The tools this template SHIPS that run before identification — the ones
 *  declaring `when: BEFORE_TRANSFER`. A pin on the shipped set: one of these
 *  quietly losing it would make the desk unreachable before a caller is
 *  identified, and nothing else would say so. A public tool of your own joins
 *  this list, or the sweeps below expect it to refuse. */
const SHIPPED_PUBLIC_TOOLS = [
  "find_user_id_by_email",
  "find_user_id_by_name_zip",
  "get_product_details",
  "get_item_details",
  "list_all_product_types",
  "transfer_to_human_agents",
];

const isPublic = (name: string) => SHIPPED_PUBLIC_TOOLS.includes(name);

/**
 * A context whose call flow is in `serving.helping`, so a `when: "serving"`
 * tool can reach its body. Moved through the FLOW rather than by writing
 * `authenticatedUserId`, because the gate reads the machine.
 *
 * The return type is `TestToolContext` — what `createToolContext` actually
 * builds — rather than the `ToolContext` this said, which is a WIDENING that
 * drops the `sent` log. The rule this and `called` below now follow together:
 * hand back the widest thing you have, and ask for the narrowest thing you
 * need.
 */
function servingCtx(): TestToolContext {
  const ctx = createToolContext();
  callFlow.send(ctx, { type: "IDENTIFIED" });
  return ctx;
}

/**
 * Minimal args satisfying each tool's schema. Deliberately plausible-shaped but
 * wrong — these calls are expected to fail.
 *
 * **It is also the list of tools this file sweeps, and the list of tools this
 * template ships.** It used to be a second copy of a seventeen-name array
 * asserted with `toEqual`, so adding one tool of your own failed both — the
 * count and the coverage — before it had run once. One source now: a tool with
 * an entry here is driven through every sweep below, and every name here must
 * still be discovered from `tools/`. Add your tool with its arguments and it
 * joins the sweeps; leave it out and it is simply not covered by them.
 */
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

/** The tools with sample args, i.e. the ones every sweep below can drive. */
const sweepable = registry.filter(([name]) => name in SAMPLE_ARGS);

describe("tool registry", () => {
  test("discovers every tool this template ships", () => {
    // `arrayContaining` rather than an exact sorted list. Fifteen of these are
    // tau2's retail tool set, which this template used to hold verbatim;
    // `confirm_change` and `cancel_change` are the two it does not have, since
    // tau2's tools apply on their first call and here nothing does (see
    // `pending.ts`). So the list is not a fidelity claim and never was a
    // COUNT — what it is worth asserting is that discovery still finds each
    // one, because a `tools/` glob that resolves nothing looks exactly like a
    // desk with no tools. Adding a tool of your own passes; losing one of these
    // fails, naming it.
    expect(registry.map(([name]) => name)).toEqual(
      expect.arrayContaining(Object.keys(SAMPLE_ARGS)),
    );
  });

  // Asserts softly: a batch of renames should list every name that no longer
  // resolves, not just the first.
  test("every name in SAMPLE_ARGS resolves to a real tool", () => {
    for (const name of Object.keys(SAMPLE_ARGS)) {
      expect.soft(retailAgent.tools[name], `SAMPLE_ARGS["${name}"] names no tool`).toBeDefined();
    }
  });

  test("every tool declares a description the model can act on", () => {
    for (const [name, def] of registry) {
      // Any tool, yours included — the model picks a tool by its description,
      // so an empty one is invisible to it.
      expect.soft(def.description, name).toBeTruthy();
    }
    for (const name of Object.keys(SAMPLE_ARGS)) {
      // The shipped ones additionally carry enough of the policy to be chosen
      // correctly, which for this desk means more than a label. `toolOf` rather
      // than `retailAgent.tools[name]?.…`: the optional chain fed `undefined`
      // into the matcher, which reports "expected undefined to be greater than
      // 40" for a tool that is simply not there.
      expect.soft(toolOf(retailAgent, name).description.length, name).toBeGreaterThan(40);
    }
  });

  /**
   * The sweeps below reach each tool's BODY, which they can only do if their
   * arguments satisfy its schema — and nothing checked that. A schema that
   * gained a required field, or renamed one, left the entry here stale and
   * every sweep still green: zod's parse happens in the runtime's tool loop,
   * not in `execute`, so a direct call hands the body a half-filled object and
   * whatever it does with that is reported as the tool's own behaviour.
   *
   * `toolInputIssues` asks the tool's OWN schema and answers a list rather than
   * throwing, which is what lets this be soft: a rename should name every entry
   * it invalidated, not just the first. The table is keyed by NAME, so the def
   * is looked up — `toolOf` is the lookup — rather than imported.
   */
  test("every SAMPLE_ARGS entry satisfies its tool's own input schema", async () => {
    for (const [name, args] of Object.entries(SAMPLE_ARGS)) {
      const def = toolOf(retailAgent, name);
      // A no-argument tool declares no schema, and there is nothing to check.
      if (def.inputSchema === undefined) continue;
      expect.soft(await toolInputIssues(def, args), `SAMPLE_ARGS["${name}"]`).toBeUndefined();
    }
  });
});

describe("the activity feed", () => {
  /** A call, delivered the way the RUNTIME delivers it: `tool.called` as the
   *  model issues it, `tool.completed` with what it was handed back. */
  const called = (name: string, ctx: TestToolContext, callId = "call_1") =>
    fireEvent(
      retailAgent,
      sessionEvent("tool.called", { toolName: name, toolCallId: callId, args: {} }),
      ctx,
    );
  const completed = (result: unknown, ctx: TestToolContext, callId = "call_1") =>
    fireEvent(
      retailAgent,
      sessionEvent("tool.completed", { toolCallId: callId, result: JSON.stringify(result) }),
      ctx,
    );

  test("every call the model makes moves the sidebar, refused or not", async () => {
    // The sidebar moves on `callSeq`, and a refused call never reaches a body —
    // so the line is the hook's, and it is written before the gate decides.
    const ctx = createToolContext();
    await called("get_user_details", ctx);
    const state = retailSlot.get(ctx);
    expect(state.callSeq).toBe(1);
    expect(state.activity.at(-1)).toMatchObject({ tool: "get_user_details", summary: "running" });
  });

  test("the completed hook fills the line with what the call answered", async () => {
    const ctx = createToolContext();
    await called("cancel_pending_order", ctx);
    await completed(
      { state: "serving.awaitingConfirmation", done: false, result: { read_back: "cancel #W1" } },
      ctx,
    );
    expect(retailSlot.get(ctx).activity.at(-1)?.summary).toBe("staged: cancel #W1");
  });

  test("a call the gate refused shows where the call was", async () => {
    const ctx = createToolContext();
    await called("get_user_details", ctx);
    await completed(await run(getUserDetails, { user_id: "x" }, ctx), ctx);
    const line = retailSlot.get(ctx).activity.at(-1);
    expect(line?.summary).toMatch(/^error: /);
    expect(line?.summary).toMatch(dialogRefusalPattern("identifying"));
  });

  test("two calls in one step keep their own lines", async () => {
    const ctx = createToolContext();
    await called("get_item_details", ctx, "call_a");
    await called("get_product_details", ctx, "call_b");
    await completed({ error: "no such product" }, ctx, "call_b");
    await completed({ result: { item_id: "1" } }, ctx, "call_a");
    expect(retailSlot.get(ctx).activity.map((line) => [line.tool, line.summary])).toEqual([
      ["get_item_details", "done"],
      ["get_product_details", "error: no such product"],
    ]);
  });
});

describe("the authentication gate", () => {
  test.each(registry.filter(([name]) => !isPublic(name)))(
    "%s refuses before the caller is identified",
    async (name, tool) => {
      const result = await run(tool, SAMPLE_ARGS[name] ?? {}, createToolContext());
      // `expectDialogRefused` rather than `isToolFailure(result)` + `toBe(true)`
      // + `if (!isToolFailure(result)) return;`. That shape is the one this
      // guide warns about: a tool that ANSWERED failed the first assertion and
      // then skipped the two that say what the refusal has to be — so the
      // interesting half of the claim only ran when it was already going to
      // pass. This throws at the call, quoting what came back instead, and
      // pins the state against the SDK's own refusal sentence rather than
      // against a `'"identifying"'` substring spelled here.
      const refusal = expectDialogRefused(result, "identifying");
      // And it quotes `identifying`'s instruction, which names the two tools
      // that get out of it — the model's recovery path.
      expect(refusal.error, `${name} refused for the wrong reason`).toContain(
        "find_user_id_by_email",
      );
    },
  );

  test.each(sweepable.filter(([name]) => isPublic(name)))(
    "%s does not require authentication",
    async (name, tool) => {
      const result = await run(tool, SAMPLE_ARGS[name] ?? {}, createToolContext());
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
  test("projects its slot under the slot name — without it the UI never updates", () => {
    // `sync: true` on the slot, collected by `agent()`: no `syncState` to forget.
    expect(Object.keys(retailAgent.syncState ?? {})).toEqual(["retail"]);
    expect(typeof retailAgent.syncState?.retail).toBe("function");
  });

  test("the empty frame is the shape with nothing in it, never the seed", () => {
    expect(retailSlot.projected()).toMatchObject({ customer: null, orders: [], productCount: 0 });
  });

  // The slot owns the default now — there is no `state` factory on the agent to
  // forget to declare, which is what four of five slot-backed templates used to.
  // What still has to hold is that the factory really is called per session: the
  // 107 KB seed is one module-level object, so a shared clone would let one
  // caller's cancellation show up in another's. `expectSlotContract` is that
  // claim plus the other two — `projected()` is the view of the EMPTY frame
  // (the slot declares `empty`), and the activity cap keeps the newest.
  test("the slot's factory clones the seed, so sessions do not share a store", () => {
    expectSlotContract(retailSlot, {
      write: (draft) => {
        draft.callSeq += 1;
      },
    });
    const a = retailSlot.create();
    const b = retailSlot.create();
    expect(a.store.orders).not.toBe(b.store.orders);
    expect(a.store).toEqual(b.store);
  });
});

describe("the transfer is terminal", () => {
  test.each(sweepable)("%s refuses once the call is with a human", async (name, tool) => {
    const ctx = servingCtx();
    callFlow.send(ctx, { type: "TRANSFERRED" });

    // EVERY tool, the six public ones and `transfer_to_human_agents` itself
    // included: nothing declares itself legal in the final state. Before the
    // flow, the policy's "say nothing else after that" was enforced by nothing.
    // One call rather than the two assertions this was: a tool that still RAN
    // fails here saying what it answered and where the flow was, which is the
    // report `expected false to be true` was not.
    expectDialogRefused(await run(tool, SAMPLE_ARGS[name] ?? {}, ctx), "transferred");
    // The state is TERMINAL, so the refusal must also have left it there — a
    // tool that refused and then advanced the call would pass the line above.
    expect(callFlow.position(ctx).state).toBe("transferred");
  });
});
