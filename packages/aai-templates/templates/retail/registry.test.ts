import { isToolFailure, type ToolContext } from "@alexkroman1/aai";
import { createToolContext, deployedAgent } from "@alexkroman1/aai/testing";
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
import { callFlow, gateFor, retailSlot } from "./store.ts";
import systemPrompt from "./system-prompt.md?raw";

const retailAgent = deployedAgent(authoredAgent, {
  tools: import.meta.glob("./tools/*.ts", { eager: true }),
  systemPrompt,
});

const registry = Object.entries(retailAgent.tools);

/**
 * Whether `name`'s gate admits the pre-identification state — i.e. whether it
 * is one of the tools that legitimately runs before the caller is identified.
 *
 * ASKED OF THE REGISTRY, not read off a list here. This used to be a hardcoded
 * six-name set, which meant a tool you add is classified by a file you did not
 * write: declare `when: BEFORE_TRANSFER` on a new catalogue read and the
 * sweeps below would have demanded it refuse. `retailTool` records every gate
 * in `TOOL_GATES`, so the honest question is what the tool itself declared.
 *
 * `undefined` — a tool built with plain `tool()` rather than `retailTool` — is
 * neither: it has no gate at all, and the sweeps skip it. That is the same
 * answer `gateFor` gives the `tool.called` hook, and "a tool this template did
 * not declare is ignored" below is the assertion for it.
 */
const isPublic = (name: string) => gateFor(name)?.includes("identifying") ?? false;

/** Registry entries that went through `retailTool`, so the gate has an opinion. */
const gatedTools = registry.filter(([name]) => gateFor(name) !== undefined);

/** The tools this template SHIPS that run before identification. A pin on the
 *  shipped set — one of these quietly losing `BEFORE_TRANSFER` is a policy
 *  break — and nothing else reads it, so adding a public tool of your own costs
 *  no edit here. */
const SHIPPED_PUBLIC_TOOLS = [
  "find_user_id_by_email",
  "find_user_id_by_name_zip",
  "get_product_details",
  "get_item_details",
  "list_all_product_types",
  "transfer_to_human_agents",
];

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

/**
 * Minimal args satisfying each tool's schema. Deliberately plausible-shaped but
 * wrong — these calls are expected to fail; what is asserted is that they still
 * moved the UI.
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
      // correctly, which for this desk means more than a label.
      expect.soft(retailAgent.tools[name]?.description.length, name).toBeGreaterThan(40);
    }
  });
});

describe("the UI-update invariant", () => {
  // Over `sweepable` rather than the whole registry: these two REACH a tool's
  // body, so they need arguments its schema accepts, and calling a tool of
  // yours with `{}` would report a crash inside it as a UI regression. Give it
  // a `SAMPLE_ARGS` entry and it is swept like the rest.
  //
  // This is the pair that fails if a future tool is built with tool() instead of
  // retailTool(): it would work, and the sidebar would sit still through it.
  test.each(sweepable)("%s increments callSeq and logs activity", async (name, def) => {
    // In whichever state lets the body run, so the flow gate is not what these
    // calls are testing: the point is that a tool which reaches its BODY moves
    // the sidebar. A refused call never reaches one — the hook below is what
    // moves the sidebar for those.
    const ctx = await bodyReachableCtx(name);
    const before = retailSlot.get(ctx).callSeq;
    await def.execute(SAMPLE_ARGS[name] ?? {}, ctx);
    const state = retailSlot.get(ctx);
    expect(state.callSeq, `${name} did not bump callSeq`).toBe(before + 1);
    expect(state.activity.at(-1)?.tool, `${name} logged the wrong tool name`).toBe(name);
    expect(state.activity.at(-1)?.summary).toBeTruthy();
  });

  test.each(sweepable)("%s logs its own registry key as its name", async (name, def) => {
    // Catches a copy-paste where the retailTool `name` and the registry key
    // disagree — the activity feed would then attribute calls to the wrong tool.
    const ctx = await bodyReachableCtx(name);
    await def.execute(SAMPLE_ARGS[name] ?? {}, ctx);
    expect(retailSlot.get(ctx).activity.at(-1)?.tool).toBe(name);
  });
});

describe("the blocked-call hook", () => {
  /**
   * A `tool.called`, delivered the way the RUNTIME delivers it.
   *
   * The hook is a plain function on the def, so this needs no harness — and
   * asserting on it here is the only way the blocked lines are covered at all:
   * they are written by something no tool call executes.
   */
  const called = (name: string, ctx: ToolContext) =>
    retailAgent.events?.["tool.called"]?.(
      {
        type: "tool.called",
        toolCallId: "call_1",
        toolName: name,
        args: {},
        meta: { id: "evt_1", at: 0 },
      },
      ctx,
    );

  test.each(gatedTools.filter(([name]) => !isPublic(name)))(
    "%s records a blocked line when the model tries it too early",
    (name) => {
      const ctx = makeCtx();
      called(name, ctx);

      // The regression this closes: the gate moved out of `retailTool` and the
      // sidebar stopped showing the most interesting calls the model makes.
      const state = retailSlot.get(ctx);
      expect(state.callSeq, `${name} recorded no blocked line`).toBe(1);
      expect(state.activity.at(-1)?.tool).toBe(name);
      expect(state.activity.at(-1)?.summary).toContain("blocked");
      expect(state.activity.at(-1)?.summary).toContain("identifying");
    },
  );

  test.each(gatedTools.filter(([name]) => isPublic(name)))(
    "%s is left to the wrapper, because it is going to run",
    (name) => {
      const ctx = makeCtx();
      called(name, ctx);
      // The double-count this avoids: a tool that reaches its body records its
      // own line from inside it, with a real summary.
      expect(retailSlot.get(ctx).activity, `${name} was double-recorded`).toEqual([]);
    },
  );

  test("a tool this template did not declare is ignored", () => {
    const ctx = makeCtx();
    called("web_search", ctx);
    // `gateFor` answers `undefined` for anything not built through `retailTool`
    // — a builtin, or a tool a future author adds outside the wrapper. Recording
    // those would put lines in the feed for calls this gate has no opinion on.
    expect(retailSlot.get(ctx).activity).toEqual([]);
  });

  test("the same tool stops being blocked once the caller is identified", async () => {
    const ctx = makeCtx();
    called("get_user_details", ctx);
    expect(retailSlot.get(ctx).activity).toHaveLength(1);

    // The hook asks the flow, so it follows the flow: same tool, same session,
    // no line once the position allows it.
    const authed = await bodyReachableCtx("get_user_details");
    const before = retailSlot.get(authed).activity.length;
    called("get_user_details", authed);
    expect(retailSlot.get(authed).activity).toHaveLength(before);
  });
});

describe("the authentication gate", () => {
  test("the tools that run before identification are still the shipped six", () => {
    // The one place `SHIPPED_PUBLIC_TOOLS` is read, and the only assertion in
    // this file about WHICH tools are public. The sweeps below classify by
    // `isPublic`, i.e. by what each tool declared, so a public tool of your own
    // needs no edit here — but one of these six quietly losing
    // `when: BEFORE_TRANSFER` would silently make the desk unreachable before a
    // caller is identified, and nothing else would say so.
    expect(registry.map(([name]) => name).filter(isPublic)).toEqual(
      expect.arrayContaining(SHIPPED_PUBLIC_TOOLS),
    );
  });

  test.each(gatedTools.filter(([name]) => !isPublic(name)))(
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

  test.each(sweepable.filter(([name]) => isPublic(name)))(
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
  test.each(gatedTools)("%s refuses once the call is with a human", async (name, def) => {
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
