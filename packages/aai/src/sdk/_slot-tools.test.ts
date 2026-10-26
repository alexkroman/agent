// Copyright 2026 the AAI authors. MIT license.
/**
 * The slot-tool pipeline, stage by stage: the dialog gate around a slot
 * tool, `require`, `prepare`, `report`, and `transact`.
 *
 * Driven through `sessionSlot().tool`/`updateTool`/`transact`, which is the
 * contract; the builders are how the handle's overloads share one body.
 */
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { runToolDef } from "./_test-utils.ts";
import { dialog } from "./dialog.ts";
import type { ToolInputSchema } from "./schema.ts";
import { sessionSlot } from "./session-slot.ts";
import type { SlotPreparedToolDef, SlotTransaction } from "./session-slot-types.ts";
import { createToolContext } from "./testing.ts";
import { isToolFailure, toolFailure } from "./utils.ts";

type Cart = { items: string[]; quote: number | null };

const emptyCart = (): Cart => ({ items: [], quote: null });

/** A two-step flow the slot tools below gate on. */
function checkoutFlow() {
  return dialog("checkout", {
    initial: "shopping",
    states: {
      shopping: { instruction: "Fill the cart.", on: { QUOTED: "paying" } },
      paying: { instruction: "Take payment.", on: { PAID: "done", BACK: "shopping" } },
      done: { final: true },
    },
  });
}

describe("a gated slot tool", () => {
  test("`tool` refuses out of state before the body reads, and wraps the read in the envelope", async () => {
    const cartSlot = sessionSlot("cart", emptyCart);
    const flow = checkoutFlow();
    const body = vi.fn((_args: Record<string, unknown>, cart: { items: readonly string[] }) => ({
      count: cart.items.length,
    }));
    const count = cartSlot.tool({
      description: "Count",
      dialog: flow,
      when: "paying",
      execute: body,
    });
    const ctx = createToolContext();
    const refused = await runToolDef(count, ctx);
    expect(isToolFailure(refused)).toBe(true);
    expect(body).not.toHaveBeenCalled();
    flow.send(ctx, { type: "QUOTED" });
    expect(await runToolDef(count, ctx)).toEqual({
      state: "paying",
      done: false,
      instruction: "Take payment.",
      result: { count: 0 },
    });
  });

  test("`updateTool` runs the window between the refusal and the send", async () => {
    const cartSlot = sessionSlot("cart", emptyCart);
    const flow = checkoutFlow();
    const add = cartSlot.updateTool({
      description: "Add",
      inputSchema: z.object({ item: z.string() }),
      dialog: flow,
      when: "shopping",
      send: { type: "QUOTED" },
      execute: ({ item }, cart) => {
        cart.items.push(item);
        return { count: cart.items.length };
      },
    });
    const ctx = createToolContext();
    expect(await add.execute({ item: "apple" }, ctx)).toMatchObject({
      state: "paying",
      result: { count: 1 },
    });
    expect(cartSlot.get(ctx).items).toEqual(["apple"]);
    // Moved on, so the second call is refused and the window never opens.
    expect(isToolFailure(await add.execute({ item: "pear" }, ctx))).toBe(true);
    expect(cartSlot.get(ctx).items).toEqual(["apple"]);
  });

  test("a failure from the window is answered unwrapped and sends nothing", async () => {
    const cartSlot = sessionSlot("cart", emptyCart);
    const flow = checkoutFlow();
    const quote = cartSlot.updateTool({
      description: "Quote",
      dialog: flow,
      send: { type: "QUOTED" },
      execute: (_args, cart) =>
        cart.items.length === 0 ? toolFailure("Nothing to quote.") : { quote: 1 },
    });
    const ctx = createToolContext();
    expect(await runToolDef(quote, ctx)).toEqual({ error: "Nothing to quote." });
    expect(flow.position(ctx).state).toBe("shopping");
  });

  test("a RETURNED failure stores nothing, gated or not — the draft's mutations are discarded", async () => {
    // The gate's rule is that a failed tool did not do the thing; the slot
    // used to store the draft anyway, so the page showed what the model was
    // told had failed.
    const cartSlot = sessionSlot("cart", emptyCart);
    const flow = checkoutFlow();
    const gated = cartSlot.updateTool({
      description: "Mutate, then decline",
      dialog: flow,
      send: { type: "QUOTED" },
      execute: (_args, cart) => {
        cart.items.push("mutated");
        return toolFailure("declined");
      },
    });
    const plain = cartSlot.updateTool({
      description: "Mutate, then decline, ungated",
      execute: (_args, cart) => {
        cart.items.push("mutated");
        return toolFailure("declined");
      },
    });
    const ctx = createToolContext();
    expect(await runToolDef(gated, ctx)).toEqual({ error: "declined" });
    expect(cartSlot.get(ctx).items).toEqual([]);
    expect(plain.execute({}, ctx)).toEqual({ error: "declined" });
    expect(cartSlot.get(ctx).items).toEqual([]);
    expect(flow.position(ctx).state).toBe("shopping");
  });

  test("`reset` is applied after `require` and `prepare` have passed, so a failed setup tool does not restart the dialog", async () => {
    const cartSlot = sessionSlot("cart", emptyCart);
    const flow = checkoutFlow();
    const ctx = createToolContext();
    flow.send(ctx, { type: "QUOTED" });
    const required = cartSlot.updateTool({
      description: "Restart, requiring",
      dialog: flow,
      reset: true,
      require: () => toolFailure("nope"),
      execute: () => "fresh",
    });
    expect(await runToolDef(required, ctx)).toEqual({ error: "nope" });
    expect(flow.position(ctx).state).toBe("paying");
    const prepared = cartSlot.updateTool({
      description: "Restart, preparing",
      dialog: flow,
      reset: true,
      prepare: async () => toolFailure("not yet"),
      execute: () => "fresh",
    });
    expect(await runToolDef(prepared, ctx)).toEqual({ error: "not yet" });
    expect(flow.position(ctx).state).toBe("paying");
    // Once they pass, the reset precedes the window: the body sees the start.
    const restart = cartSlot.updateTool({
      description: "Restart",
      dialog: flow,
      reset: true,
      prepare: async () => 1,
      execute: (_args, _cart, _n, c) => flow.position(c).state,
    });
    expect(await runToolDef(restart, ctx)).toMatchObject({ state: "shopping", result: "shopping" });
  });

  test("a field-name `sendFrom` whose field holds no event name is refused INSIDE the window, storing nothing", async () => {
    const cartSlot = sessionSlot("cart", emptyCart);
    const flow = checkoutFlow();
    const add = cartSlot.updateTool({
      description: "Add",
      dialog: flow,
      sendFrom: "next",
      // The erased shape an untyped caller reaches the gate with.
      execute: (_args, cart): { next?: "QUOTED" } => {
        cart.items.push("a");
        return JSON.parse('{"next":42}');
      },
    });
    const ctx = createToolContext();
    await expect(runToolDef(add, ctx)).rejects.toThrow(/"next" field holds number/);
    expect(cartSlot.get(ctx).items).toEqual([]);
    expect(flow.position(ctx).state).toBe("shopping");
  });

  test("`sendFrom` — callback, field name, or second argument — decides the transition", async () => {
    const cartSlot = sessionSlot("cart", emptyCart);
    const flow = checkoutFlow();
    const ctx = createToolContext();
    const byField = cartSlot.tool({
      description: "Quote",
      dialog: flow,
      sendFrom: "next",
      execute: (): { next?: "QUOTED" } => ({ next: "QUOTED" }),
    });
    expect(await runToolDef(byField, ctx)).toMatchObject({ state: "paying" });
    const byOption = cartSlot.updateTool(
      {
        description: "Pay or back out",
        dialog: flow,
        when: "paying",
        execute: (_args, cart) => ({ paid: cart.items.length > 0 }),
      },
      { sendFrom: (result) => (result.paid ? { type: "PAID" } : { type: "BACK" }) },
    );
    expect(await runToolDef(byOption, ctx)).toMatchObject({ state: "shopping" });
  });

  test("gate fields without a `dialog` are refused at declaration", () => {
    const cartSlot = sessionSlot("cart", emptyCart);
    // The erased shape a JS caller reaches the builder with.
    const stray = { description: "Stray", when: "paying", execute: () => 1 };
    const strayer = { ...stray, send: { type: "X" } };
    expect(() => cartSlot.tool(stray)).toThrow(/declares when but no `dialog`/);
    expect(() => cartSlot.updateTool(strayer)).toThrow(/declares when, send but no `dialog`/);
  });

  test("the gate's own refusals still hold: an unknown `when` state at declaration", () => {
    const cartSlot = sessionSlot("cart", emptyCart);
    const flow = checkoutFlow();
    expect(() =>
      cartSlot.tool({ description: "x", dialog: flow, when: "checkout", execute: () => 1 }),
    ).toThrow(/has no state "checkout"/);
  });

  test("the wire def carries neither the gate nor the stages", () => {
    const cartSlot = sessionSlot("cart", emptyCart);
    const flow = checkoutFlow();
    const def = cartSlot.updateTool({
      description: "x",
      dialog: flow,
      when: "shopping",
      send: { type: "QUOTED" },
      require: () => undefined,
      report: (_stored, partial) => partial,
      execute: () => 1,
    });
    expect(Object.keys(def).sort()).toEqual(["description", "execute"]);
  });
});

describe("`require`", () => {
  test("on `tool`: a refusal is the result and the body does not run", () => {
    const cartSlot = sessionSlot("cart", emptyCart);
    const body = vi.fn(() => "ran");
    const total = cartSlot.tool({
      description: "Total",
      require: (cart) => (cart.items.length === 0 ? toolFailure("Empty.") : undefined),
      execute: body,
    });
    const ctx = createToolContext();
    expect(total.execute({}, ctx)).toEqual({ error: "Empty." });
    expect(body).not.toHaveBeenCalled();
    cartSlot.update(ctx, (cart) => cart.items.push("a"));
    expect(total.execute({}, ctx)).toBe("ran");
  });

  test("on `updateTool`: no window opens, so nothing is stored and nothing sent", async () => {
    const cartSlot = sessionSlot("cart", emptyCart);
    const flow = checkoutFlow();
    const body = vi.fn((_args: Record<string, unknown>, cart: Cart) => {
      cart.items.push("x");
      return 1;
    });
    const add = cartSlot.updateTool({
      description: "Add",
      dialog: flow,
      send: { type: "QUOTED" },
      require: (cart, args) =>
        cart.quote !== null ? toolFailure(`Quoted ${String(args.why)}.`) : undefined,
      execute: body,
    });
    const ctx = createToolContext();
    cartSlot.update(ctx, (cart) => {
      cart.quote = 5;
    });
    expect(await add.execute({ why: "already" }, ctx)).toEqual({ error: "Quoted already." });
    expect(body).not.toHaveBeenCalled();
    expect(cartSlot.get(ctx).items).toEqual([]);
    expect(flow.position(ctx).state).toBe("shopping");
  });

  test("is handed the FROZEN value on both methods", () => {
    const cartSlot = sessionSlot("cart", emptyCart);
    const seen: boolean[] = [];
    const probe = (cart: unknown): undefined => {
      seen.push(Object.isFrozen(cart));
    };
    const ctx = createToolContext();
    expect(
      cartSlot.tool({ description: "r", require: probe, execute: () => 1 }).execute({}, ctx),
    ).toBe(1);
    expect(
      cartSlot.updateTool({ description: "u", require: probe, execute: () => 1 }).execute({}, ctx),
    ).toBe(1);
    expect(seen).toEqual([true, true]);
  });

  test("the dialog refusal comes first", async () => {
    const cartSlot = sessionSlot("cart", emptyCart);
    const flow = checkoutFlow();
    const require = vi.fn(() => undefined);
    const pay = cartSlot.tool({
      description: "Pay",
      dialog: flow,
      when: "paying",
      require,
      execute: () => 1,
    });
    const ctx = createToolContext();
    expect(isToolFailure(await runToolDef(pay, ctx))).toBe(true);
    expect(require).not.toHaveBeenCalled();
  });
});

describe("`prepare`", () => {
  test("runs before the window with the frozen value, and the body gets its result third", async () => {
    const cartSlot = sessionSlot("cart", emptyCart);
    const order: string[] = [];
    const price = cartSlot.updateTool({
      description: "Price",
      inputSchema: z.object({ rate: z.number() }),
      prepare: async ({ rate }, cart) => {
        order.push(`prepare:${Object.isFrozen(cart)}`);
        await Promise.resolve();
        return rate * cart.items.length;
      },
      execute: (_args, cart, quote, ctx) => {
        order.push(`execute:${typeof ctx.sessionId}`);
        cart.quote = quote;
        return { quote };
      },
    });
    const ctx = createToolContext();
    cartSlot.update(ctx, (cart) => cart.items.push("a", "b"));
    expect(await price.execute({ rate: 3 }, ctx)).toEqual({ quote: 6 });
    expect(cartSlot.get(ctx).quote).toBe(6);
    expect(order).toEqual(["prepare:true", "execute:string"]);
  });

  test("a failure from `prepare` is the result, and no window opens", async () => {
    const cartSlot = sessionSlot("cart", emptyCart);
    const body = vi.fn(() => 1);
    const price = cartSlot.updateTool({
      description: "Price",
      prepare: async () => toolFailure("Pricing is down."),
      execute: body,
    });
    const ctx = createToolContext();
    expect(await price.execute({}, ctx)).toEqual({ error: "Pricing is down." });
    expect(body).not.toHaveBeenCalled();
  });

  test("`require` is re-evaluated on the fresh value after the await", async () => {
    const cartSlot = sessionSlot("cart", emptyCart);
    const gate = Promise.withResolvers<void>();
    const body = vi.fn(() => 1);
    const price = cartSlot.updateTool({
      description: "Price",
      require: (cart) => (cart.quote !== null ? toolFailure("Already quoted.") : undefined),
      prepare: async () => {
        await gate.promise;
        return 9;
      },
      execute: body,
    });
    const ctx = createToolContext();
    const call = price.execute({}, ctx);
    // A sibling quotes during the await.
    cartSlot.update(ctx, (cart) => {
      cart.quote = 1;
    });
    gate.resolve();
    expect(await call).toEqual({ error: "Already quoted." });
    expect(body).not.toHaveBeenCalled();
  });

  test("the window is still synchronous — a body returning a promise is refused", async () => {
    const cartSlot = sessionSlot("cart", emptyCart);
    // Typed as a sync body answering `unknown` (which admits a promise): how a
    // JS caller or a generic wrapper reaches the runtime guard past the
    // compile-time one.
    const def: SlotPreparedToolDef<ToolInputSchema, Cart, number, unknown> = {
      description: "Bad",
      prepare: () => 1,
      execute: () => Promise.resolve(),
    };
    const ctx = createToolContext();
    await expect(cartSlot.updateTool(def).execute({}, ctx)).rejects.toThrow(/must be synchronous/);
  });

  test("composes with the gate: refusal, prepare, window, send", async () => {
    const cartSlot = sessionSlot("cart", emptyCart);
    const flow = checkoutFlow();
    const price = cartSlot.updateTool({
      description: "Price",
      dialog: flow,
      when: "shopping",
      send: { type: "QUOTED" },
      prepare: async (_args, cart) => cart.items.length * 2,
      execute: (_args, cart, quote) => {
        cart.quote = quote;
        return { quote };
      },
    });
    const ctx = createToolContext();
    cartSlot.update(ctx, (cart) => cart.items.push("a"));
    expect(await runToolDef(price, ctx)).toMatchObject({ state: "paying", result: { quote: 2 } });
    expect(isToolFailure(await runToolDef(price, ctx))).toBe(true);
  });
});

describe("`report`", () => {
  test("sees the value as stored — after `after` and `caps` — and becomes the result", () => {
    const logSlot = sessionSlot(
      "log",
      (): { lines: string[]; n: number } => ({ lines: [], n: 0 }),
      {
        caps: { lines: 2 },
        after: (log) => {
          log.n = log.lines.length;
        },
      },
    );
    const append = logSlot.updateTool({
      description: "Append",
      execute: (_args, log) => {
        log.lines.push("a", "b", "c");
        return { pushed: 3, draftLength: log.lines.length };
      },
      report: (stored, partial) => ({ ...partial, kept: stored.lines.length, n: stored.n }),
    });
    const ctx = createToolContext();
    expect(append.execute({}, ctx)).toEqual({ pushed: 3, draftLength: 3, kept: 2, n: 3 });
  });

  test("is skipped on a failure, which is answered unchanged", () => {
    const cartSlot = sessionSlot("cart", emptyCart);
    const report = vi.fn(() => "reported");
    const fail = cartSlot.updateTool({
      description: "Fail",
      execute: () => toolFailure("no"),
      report,
    });
    const ctx = createToolContext();
    expect(fail.execute({}, ctx)).toEqual({ error: "no" });
    expect(report).not.toHaveBeenCalled();
  });

  test("runs INSIDE the window: a failure it returns, or a throw, stores nothing", () => {
    const cartSlot = sessionSlot("cart", emptyCart);
    const declined = cartSlot.updateTool({
      description: "Add, then decline in report",
      execute: (_args, cart) => {
        cart.items.push("a");
        return { added: "a" };
      },
      report: () => toolFailure("declined"),
    });
    const thrown = cartSlot.updateTool({
      description: "Add, then throw in report",
      execute: (_args, cart) => {
        cart.items.push("a");
        return { added: "a" };
      },
      report: () => {
        throw new Error("boom");
      },
    });
    const ctx = createToolContext();
    expect(declined.execute({}, ctx)).toEqual({ error: "declined" });
    expect(cartSlot.get(ctx).items).toEqual([]);
    expect(() => thrown.execute({}, ctx)).toThrow("boom");
    expect(cartSlot.get(ctx).items).toEqual([]);
  });

  test("a `report` answering a promise is settled after the window, and a gated `sendFrom` reads it", async () => {
    const cartSlot = sessionSlot("cart", emptyCart);
    const flow = checkoutFlow();
    const add = cartSlot.updateTool({
      description: "Add, reported later",
      dialog: flow,
      sendFrom: "next",
      execute: (_args, cart) => {
        cart.items.push("a");
        return { added: "a" };
      },
      report: async (stored, partial): Promise<{ added: string; next: "QUOTED" | undefined }> => ({
        ...partial,
        next: stored.items.length > 0 ? "QUOTED" : undefined,
      }),
    });
    const ctx = createToolContext();
    expect(await runToolDef(add, ctx)).toMatchObject({
      state: "paying",
      result: { added: "a", next: "QUOTED" },
    });
    expect(cartSlot.get(ctx).items).toEqual(["a"]);
  });

  test("`sendFrom` sees the reported value", async () => {
    const cartSlot = sessionSlot("cart", emptyCart);
    const flow = checkoutFlow();
    const add = cartSlot.updateTool({
      description: "Add",
      dialog: flow,
      sendFrom: "next",
      execute: (_args, cart) => {
        cart.items.push("a");
        return { added: "a" };
      },
      report: (stored, partial): { added: string; next: "QUOTED" | undefined } => ({
        ...partial,
        next: stored.items.length > 0 ? "QUOTED" : undefined,
      }),
    });
    const ctx = createToolContext();
    expect(await runToolDef(add, ctx)).toMatchObject({
      state: "paying",
      result: { added: "a", next: "QUOTED" },
    });
  });
});

describe("`transact`", () => {
  test("awaits `prepare` on the frozen value, then commits in a window", async () => {
    const cartSlot = sessionSlot("cart", emptyCart);
    const ctx = createToolContext();
    cartSlot.update(ctx, (cart) => cart.items.push("a"));
    const result = await cartSlot.transact(ctx, {
      prepare: async (cart) => cart.items.length * 10,
      commit: (cart, quote) => {
        cart.quote = quote;
        return { quote };
      },
    });
    expect(result).toEqual({ quote: 10 });
    expect(cartSlot.get(ctx).quote).toBe(10);
  });

  test("a failure from `prepare` or `require` ends it with nothing stored", async () => {
    const cartSlot = sessionSlot("cart", emptyCart);
    const ctx = createToolContext();
    const commit = vi.fn(() => 1);
    expect(await cartSlot.transact(ctx, { prepare: () => toolFailure("down"), commit })).toEqual({
      error: "down",
    });
    expect(
      await cartSlot.transact(ctx, {
        require: () => toolFailure("not yet"),
        prepare: () => 1,
        commit,
      }),
    ).toEqual({ error: "not yet" });
    expect(commit).not.toHaveBeenCalled();
  });

  test("`require` runs again on the fresh value before the window", async () => {
    const cartSlot = sessionSlot("cart", emptyCart);
    const ctx = createToolContext();
    const gate = Promise.withResolvers<void>();
    const call = cartSlot.transact(ctx, {
      require: (cart) => (cart.quote !== null ? toolFailure("quoted") : undefined),
      prepare: async () => {
        await gate.promise;
        return 1;
      },
      commit: () => "committed",
    });
    cartSlot.update(ctx, (cart) => {
      cart.quote = 2;
    });
    gate.resolve();
    expect(await call).toEqual({ error: "quoted" });
  });

  test("a failure RETURNED from `commit` stores nothing, like a throw", async () => {
    const cartSlot = sessionSlot("cart", emptyCart);
    const ctx = createToolContext();
    const result = await cartSlot.transact(ctx, {
      prepare: async () => 1,
      commit: (cart) => {
        cart.items.push("mutated");
        return toolFailure("declined");
      },
    });
    expect(result).toEqual({ error: "declined" });
    expect(cartSlot.get(ctx).items).toEqual([]);
  });

  test("the window is synchronous", async () => {
    const cartSlot = sessionSlot("cart", emptyCart);
    const ctx = createToolContext();
    const tx: SlotTransaction<Cart, number, unknown> = {
      prepare: () => 1,
      commit: () => Promise.resolve(),
    };
    await expect(cartSlot.transact(ctx, tx)).rejects.toThrow(/cart.transact must be synchronous/);
  });
});
