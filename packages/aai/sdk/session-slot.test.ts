// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { sessionSlot } from "./session-slot.ts";
import { createToolContext } from "./testing.ts";

type Cart = { items: string[]; nextId: number };

const emptyCart = (): Cart => ({ items: [], nextId: 1 });
const cartSlot = sessionSlot("cart", emptyCart);

describe("sessionSlot", () => {
  test("exposes the key it occupies", () => {
    expect(cartSlot.key).toBe("cart");
  });

  test("get installs the default on first access and stores it under the key", () => {
    const ctx = createToolContext<{ cart?: Cart }>();
    expect(ctx.state.cart).toBeUndefined();
    expect(cartSlot.get(ctx)).toEqual({ items: [], nextId: 1 });
    expect(ctx.state.cart).toEqual({ items: [], nextId: 1 });
  });

  test("mutations to the returned value stick — it IS the stored object", () => {
    const ctx = createToolContext<{ cart?: Cart }>();
    cartSlot.get(ctx).items.push("apple");
    // The whole contract: a tool mutates what `get` returned and the next
    // tool call sees it. A `get` that returned a copy would pass every other
    // test in this file and lose every write.
    expect(cartSlot.get(ctx).items).toEqual(["apple"]);
    expect(ctx.state.cart?.items).toEqual(["apple"]);
  });

  test("get returns the same object across calls — the factory runs once", () => {
    let calls = 0;
    const slot = sessionSlot("counted", () => {
      calls += 1;
      return { n: calls };
    });
    const ctx = createToolContext<{ counted?: { n: number } }>();
    expect(slot.get(ctx)).toBe(slot.get(ctx));
    expect(calls).toBe(1);
  });

  test("two contexts are two sessions — neither sees the other's value", () => {
    const a = createToolContext<{ cart?: Cart }>();
    const b = createToolContext<{ cart?: Cart }>();
    cartSlot.get(a).items.push("apple");
    expect(cartSlot.get(b).items).toEqual([]);
  });

  test("a shared module-level default is not aliased when the factory clones", () => {
    const DEFAULT: Cart = { items: [], nextId: 1 };
    const slot = sessionSlot("cloned", () => structuredClone(DEFAULT));
    const a = createToolContext<{ cloned?: Cart }>();
    const b = createToolContext<{ cloned?: Cart }>();
    slot.get(a).items.push("apple");
    expect(slot.get(b).items).toEqual([]);
    expect(DEFAULT.items).toEqual([]);
  });

  test("set replaces the value wholesale and returns it", () => {
    const ctx = createToolContext<{ cart?: Cart }>();
    cartSlot.get(ctx).items.push("apple");
    const loaded: Cart = { items: ["pear"], nextId: 9 };
    expect(cartSlot.set(ctx, loaded)).toBe(loaded);
    expect(cartSlot.get(ctx)).toBe(loaded);
  });

  test("reset discards the value and installs a fresh default", () => {
    const ctx = createToolContext<{ cart?: Cart }>();
    cartSlot.get(ctx).items.push("apple");
    const fresh = cartSlot.reset(ctx);
    expect(fresh.items).toEqual([]);
    expect(cartSlot.get(ctx)).toBe(fresh);
  });

  test("reset returns a NEW object, not the mutated one cleared in place", () => {
    const ctx = createToolContext<{ cart?: Cart }>();
    const before = cartSlot.get(ctx);
    expect(cartSlot.reset(ctx)).not.toBe(before);
  });

  test("a slot holding undefined counts as absent", () => {
    // Reachable at runtime however the type is spelled — a JSON round-trip
    // through a save file, or a `state` factory that names the key without a
    // value. Installed with `Object.assign` (which copies an own property
    // holding `undefined`) because `exactOptionalPropertyTypes` will not let
    // `SlotState` say it.
    const ctx = createToolContext<{ cart?: Cart }>();
    Object.assign(ctx.state, { cart: undefined });
    expect("cart" in ctx.state).toBe(true);
    expect(cartSlot.get(ctx)).toEqual({ items: [], nextId: 1 });
  });

  describe("read", () => {
    test("returns the stored value when present", () => {
      const cart: Cart = { items: ["apple"], nextId: 2 };
      expect(cartSlot.read({ cart })).toBe(cart);
    });

    test("defaults for an empty state object", () => {
      expect(cartSlot.read({})).toEqual({ items: [], nextId: 1 });
    });

    test("defaults for undefined state", () => {
      expect(cartSlot.read(undefined)).toEqual({ items: [], nextId: 1 });
    });

    test("a slot holding a falsy value is not defaulted away", () => {
      // `read` and `get` must agree on what "absent" means, or a projection and
      // a tool see different state for the same session. Only `undefined`
      // counts — a `??` here would swallow `null` and `0`.
      const nullable = sessionSlot<"maybe", Cart | null>("maybe", () => emptyCart());
      expect(nullable.read({ maybe: null })).toBeNull();
      const zero = sessionSlot("count", () => 7);
      expect(zero.read({ count: 0 })).toBe(0);
    });

    test("does not install the default into the state it was handed", () => {
      // `read` is the `syncState` path — a projection must not mutate the
      // session it is projecting.
      const state: { cart?: Cart } = {};
      cartSlot.read(state);
      expect(state.cart).toBeUndefined();
    });
  });

  describe("projection", () => {
    const view = (cart: Cart) => ({ count: cart.items.length });

    test("projects the stored value", () => {
      const project = cartSlot.projection(view);
      expect(project({ cart: { items: ["a", "b"], nextId: 3 } })).toEqual({ count: 2 });
    });

    test("projects the default before anything is stored", () => {
      // This is what makes a client's empty-state fallback derivable from the
      // projection itself rather than hand-written.
      expect(cartSlot.projection(view)({})).toEqual({ count: 0 });
      expect(cartSlot.projection(view)(undefined)).toEqual({ count: 0 });
    });

    test("the projection sees a non-optional value", () => {
      // The point of `projection` over `read`: the callback's parameter is
      // `Cart`, so a projection needs no optional chaining. A type-level
      // claim, asserted at runtime by dereferencing without a guard.
      expect(cartSlot.projection((cart) => cart.items.length)(undefined)).toBe(0);
    });
  });

  describe("update", () => {
    test("mutates the live value and resolves with the mutator's return", async () => {
      const ctx = createToolContext<{ cart?: Cart }>();
      const result = await cartSlot.update(ctx, (cart) => {
        cart.items.push("apple");
        return cart.items.length;
      });
      expect(result).toBe(1);
      expect(cartSlot.get(ctx).items).toEqual(["apple"]);
    });

    test("installs the default on first use, like get", async () => {
      const ctx = createToolContext<{ cart?: Cart }>();
      await cartSlot.update(ctx, () => undefined);
      expect(ctx.state.cart).toEqual({ items: [], nextId: 1 });
    });

    test("serializes concurrent async mutators of one session", async () => {
      // THE reason this method exists: the LLM loop runs a step's tool calls
      // concurrently, so two async mutators interleave at every await. Without
      // the lock both read `items.length === 0` and the second write wins,
      // leaving one item instead of two.
      const ctx = createToolContext<{ cart?: Cart }>();
      const appendSlowly = (sku: string) =>
        cartSlot.update(ctx, async (cart) => {
          const seen = cart.items.length;
          await Promise.resolve();
          await Promise.resolve();
          cart.items = [...cart.items.slice(0, seen), sku];
        });
      await Promise.all([appendSlowly("a"), appendSlowly("b")]);
      expect(cartSlot.get(ctx).items).toEqual(["a", "b"]);
    });

    test("does not serialize across sessions", async () => {
      // Two callers must not queue behind each other — the lock is keyed by
      // session id, and blocking on a stranger's tool call would be a latency
      // bug that only shows up under concurrency.
      const a = createToolContext<{ cart?: Cart }>();
      const b = createToolContext<{ cart?: Cart }>();
      const started = new Set<string>();
      const bothInFlight = Promise.withResolvers<void>();
      const enter = (ctx: typeof a, name: string) =>
        cartSlot.update(ctx, async () => {
          started.add(name);
          if (started.size === 2) bothInFlight.resolve();
          await bothInFlight.promise;
        });
      // Resolves only if the two ran at the same time; a shared lock hangs.
      await Promise.all([enter(a, "a"), enter(b, "b")]);
      expect([...started].sort()).toEqual(["a", "b"]);
    });

    test("a rejecting mutator does not wedge the lock", async () => {
      const ctx = createToolContext<{ cart?: Cart }>();
      await expect(cartSlot.update(ctx, () => Promise.reject(new Error("boom")))).rejects.toThrow(
        "boom",
      );
      await expect(cartSlot.update(ctx, (cart) => cart.items.length)).resolves.toBe(0);
    });

    describe("the after hook", () => {
      const capped = sessionSlot("log", (): { entries: string[] } => ({ entries: [] }), {
        after: (value) => {
          value.entries = value.entries.slice(-2);
        },
      });

      test("runs inside the lock after a successful mutation", async () => {
        const ctx = createToolContext<{ log?: { entries: string[] } }>();
        await capped.update(ctx, (log) => log.entries.push("a", "b", "c", "d"));
        expect(capped.get(ctx).entries).toEqual(["c", "d"]);
      });

      test("runs on every update, not only the first", async () => {
        const ctx = createToolContext<{ log?: { entries: string[] } }>();
        await capped.update(ctx, (log) => log.entries.push("a", "b", "c"));
        await capped.update(ctx, (log) => log.entries.push("d", "e", "f"));
        expect(capped.get(ctx).entries).toEqual(["e", "f"]);
      });

      test("does NOT run when the mutator throws, and the mutator's error wins", async () => {
        const ctx = createToolContext<{ log?: { entries: string[] } }>();
        await expect(
          capped.update(ctx, (log) => {
            log.entries.push("a", "b", "c");
            throw new Error("mid-mutation");
          }),
        ).rejects.toThrow("mid-mutation");
        // Untrimmed: the half-applied value is left exactly as the mutator left
        // it rather than being normalized by a hook that never saw a complete
        // mutation.
        expect(capped.get(ctx).entries).toEqual(["a", "b", "c"]);
      });

      test("normalizes the value the slot NOW holds, after a mutator's set", async () => {
        // A mutator that loads or restores calls `set`, replacing the object it
        // was handed. The hook has to see the replacement — running it on the
        // stale reference would leave the loaded value untrimmed.
        const ctx = createToolContext<{ log?: { entries: string[] } }>();
        await capped.update(ctx, () => {
          capped.set(ctx, { entries: ["w", "x", "y", "z"] });
        });
        expect(capped.get(ctx).entries).toEqual(["y", "z"]);
      });

      test("a slot with no hook is unaffected", async () => {
        const ctx = createToolContext<{ cart?: Cart }>();
        await expect(cartSlot.update(ctx, (cart) => cart.items.length)).resolves.toBe(0);
      });
    });
  });

  describe("state", () => {
    test("is the AgentDef.state factory for this slot", () => {
      expect(cartSlot.state()).toEqual({ cart: { items: [], nextId: 1 } });
    });

    test("mints a fresh value per call — it runs once per SESSION", () => {
      // Returning one shared object would give every concurrent caller the same
      // cart, which is the bug `create` being a factory exists to prevent.
      const first = cartSlot.state();
      const second = cartSlot.state();
      expect(first.cart).not.toBe(second.cart);
    });

    test("the state it builds is the one `get` then finds", () => {
      // The property that makes it a drop-in for the hand-written
      // `() => ({ [slot.key]: slot.create() })`: a session started from it is
      // already installed, so `get` returns what is there rather than
      // installing a second value over it.
      const ctx = createToolContext<{ cart?: Cart }>({ state: cartSlot.state() });
      const installed = ctx.state.cart;
      cartSlot.get(ctx).items.push("apple");
      expect(cartSlot.get(ctx)).toBe(installed);
      expect(ctx.state.cart?.items).toEqual(["apple"]);
    });
  });

  describe("tool", () => {
    const addItem = cartSlot.tool({
      description: "Add an item",
      inputSchema: z.object({ item: z.string() }),
      execute: ({ item }, cart) => {
        cart.items.push(item);
        return { count: cart.items.length };
      },
    });

    test("hands the body the live value, and the write sticks", async () => {
      const ctx = createToolContext<{ cart?: Cart }>();
      expect(await addItem.execute({ item: "apple" }, ctx)).toEqual({ count: 1 });
      expect(ctx.state.cart?.items).toEqual(["apple"]);
    });

    test("carries description and inputSchema through unchanged", () => {
      expect(addItem.description).toBe("Add an item");
      expect(addItem.inputSchema).toBeDefined();
    });

    test("a schemaless tool has no inputSchema key at all", () => {
      // Not merely undefined: `exactOptionalPropertyTypes` is on, and the
      // manifest walks these objects, so a present-but-undefined key is a
      // different value from an absent one.
      const view = cartSlot.tool({ description: "View", execute: (_args, cart) => cart.items });
      expect("inputSchema" in view).toBe(false);
    });

    test("still receives ctx third, for the tools that need it", async () => {
      const ping = cartSlot.tool({
        description: "Ping",
        execute: (_args, _cart, ctx) => {
          ctx.send("ping", { ok: true });
          return "sent";
        },
      });
      const ctx = createToolContext<{ cart?: Cart }>();
      expect(await ping.execute({}, ctx)).toBe("sent");
      expect(ctx.sent).toEqual([{ event: "ping", data: { ok: true } }]);
    });
  });

  describe("updateTool", () => {
    test("serializes concurrent bodies that await", async () => {
      // The invariant the whole method exists for. Each body reads the length,
      // awaits, then writes back length + 1 — the classic lost update. Under
      // `tool` (i.e. `get`) both read 0 and the cart ends with one entry; under
      // `updateTool` the second body cannot start until the first released.
      const slot = sessionSlot("cart", emptyCart);
      const append = slot.updateTool({
        description: "Append",
        inputSchema: z.object({ item: z.string() }),
        execute: async ({ item }, cart) => {
          const seen = cart.items.length;
          await Promise.resolve();
          cart.items[seen] = item;
          return cart.items.length;
        },
      });
      const ctx = createToolContext<{ cart?: Cart }>();
      const results = await Promise.all([
        append.execute({ item: "a" }, ctx),
        append.execute({ item: "b" }, ctx),
      ]);
      expect(results).toEqual([1, 2]);
      expect(slot.get(ctx).items).toEqual(["a", "b"]);
    });

    test("runs the slot's after hook", async () => {
      const capped = sessionSlot("cart", emptyCart, {
        after: (cart) => {
          cart.items.splice(0, Math.max(cart.items.length - 2, 0));
        },
      });
      const add = capped.updateTool({
        description: "Add three",
        execute: (_args, cart) => {
          cart.items.push("x", "y", "z");
        },
      });
      const ctx = createToolContext<{ cart?: Cart }>();
      await add.execute({}, ctx);
      expect(capped.get(ctx).items).toEqual(["y", "z"]);
    });

    test("propagates a throwing body, and the lock still releases", async () => {
      const slot = sessionSlot("cart", emptyCart);
      const boom = slot.updateTool({
        description: "Boom",
        execute: () => {
          throw new Error("nope");
        },
      });
      const ok = slot.updateTool({
        description: "Ok",
        execute: (_args, cart) => cart.items.length,
      });
      const ctx = createToolContext<{ cart?: Cart }>();
      await expect(boom.execute({}, ctx)).rejects.toThrow("nope");
      // A release that only ran on the happy path would wedge every later
      // mutation of this slot for the life of the session.
      await expect(ok.execute({}, ctx)).resolves.toBe(0);
    });
  });

  test("two slots on one state object stay independent", () => {
    const other = sessionSlot("flags", () => ({ seen: false }));
    const ctx = createToolContext<{ cart?: Cart; flags?: { seen: boolean } }>();
    cartSlot.get(ctx).items.push("apple");
    other.get(ctx).seen = true;
    expect(ctx.state).toEqual({ cart: { items: ["apple"], nextId: 1 }, flags: { seen: true } });
  });
});
