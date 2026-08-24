// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { type DeepReadonly, sessionSlot } from "./session-slot.ts";
import { createToolContext } from "./testing.ts";

type Cart = { items: string[]; nextId: number };

const emptyCart = (): Cart => ({ items: [], nextId: 1 });
const cartSlot = sessionSlot("cart", emptyCart);

/**
 * Values that do not survive being stored, and the fragment each error must name.
 *
 * Hoisted out of the `test.each` call site rather than written inline: the arrow
 * in the function row reads to `check-test-assertions.mjs` as an untitled test
 * body with no `expect` in it, which fails that gate on a table.
 */
const UNSTORABLE: readonly [string, unknown, RegExp][] = [
  ["a Map", new Map([["a", 1]]), /a Map/],
  ["a Set", new Set([1]), /a Set/],
  ["a Date", new Date(0), /a Date/],
  ["NaN", Number.NaN, /NaN/],
  ["Infinity", Number.POSITIVE_INFINITY, /Infinity/],
  ["a function", () => 1, /a function/],
  ["a bigint", 1n, /a bigint/],
  ["a class instance", new (class Point {})(), /Point instance/],
];

describe("sessionSlot", () => {
  test("exposes the key it occupies and its durability", () => {
    expect(cartSlot.key).toBe("cart");
    expect(cartSlot.durable).toBe(true);
  });

  test("get installs the default on first access", () => {
    const ctx = createToolContext();
    expect(ctx.slots.read("cart")).toBeUndefined();
    expect(cartSlot.get(ctx)).toEqual({ items: [], nextId: 1 });
    expect(ctx.slots.read("cart")).toEqual({ items: [], nextId: 1 });
  });

  test("get returns the same object across calls — the factory runs once", () => {
    let calls = 0;
    const slot = sessionSlot("counted", () => {
      calls += 1;
      return { n: calls };
    });
    const ctx = createToolContext();
    expect(slot.get(ctx)).toBe(slot.get(ctx));
    expect(calls).toBe(1);
  });

  test("what get returns is FROZEN, so a lost write is a throw", () => {
    // The whole read contract. A mutation applied here is applied to a value
    // nothing is going to store. The type says so at every depth now
    // (`DeepReadonly<T>` — see `define.test-d.ts`), so the cast below is what it
    // takes to reach this throw; it stays because the freeze is the guarantee at
    // an UNTYPED call site, which is where a domain helper's write lands.
    const ctx = createToolContext();
    const cart = cartSlot.get(ctx);
    expect(Object.isFrozen(cart)).toBe(true);
    expect(Object.isFrozen(cart.items)).toBe(true);
    expect(() => {
      (cart as Cart).items.push("apple");
    }).toThrow(TypeError);
  });

  test("two contexts are two sessions — neither sees the other's value", () => {
    const a = createToolContext();
    const b = createToolContext();
    cartSlot.update(a, (cart) => cart.items.push("apple"));
    expect(cartSlot.get(b).items).toEqual([]);
  });

  test("a shared module-level default is not aliased when the factory clones", () => {
    const DEFAULT: Cart = { items: [], nextId: 1 };
    const slot = sessionSlot("cloned", () => structuredClone(DEFAULT));
    const a = createToolContext();
    const b = createToolContext();
    slot.update(a, (cart) => cart.items.push("apple"));
    expect(slot.get(b).items).toEqual([]);
    expect(DEFAULT.items).toEqual([]);
  });

  test("set replaces the value wholesale and returns what it stored", () => {
    const ctx = createToolContext();
    cartSlot.update(ctx, (cart) => cart.items.push("apple"));
    const loaded: Cart = { items: ["pear"], nextId: 9 };
    const stored = cartSlot.set(ctx, loaded);
    expect(stored).toEqual(loaded);
    expect(cartSlot.get(ctx)).toBe(stored);
  });

  test("set stores a COPY, so the caller's own object is not frozen under it", () => {
    // The failure this pins: `set`'s own doc names a load, an import and a
    // restore — every one of which is a caller still holding the object it
    // passed. Freezing that object in place turned the caller's next line into
    // a `TypeError` from a stack naming nothing about this slot.
    const ctx = createToolContext();
    const loaded: Cart = { items: ["pear"], nextId: 9 };
    cartSlot.set(ctx, loaded);
    expect(Object.isFrozen(loaded)).toBe(false);
    expect(Object.isFrozen(loaded.items)).toBe(false);
    expect(() => loaded.items.push("plum")).not.toThrow();
    // …and the slot did not follow the caller's mutation.
    expect(cartSlot.get(ctx).items).toEqual(["pear"]);
  });

  test("what set returns is frozen all the way down, as get's is", () => {
    const ctx = createToolContext();
    const stored = cartSlot.set(ctx, { items: ["pear"], nextId: 9 });
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored.items)).toBe(true);
  });

  test("reset discards the value and installs a fresh default", () => {
    const ctx = createToolContext();
    cartSlot.update(ctx, (cart) => cart.items.push("apple"));
    const fresh = cartSlot.reset(ctx);
    expect(fresh.items).toEqual([]);
    expect(cartSlot.get(ctx)).toBe(fresh);
  });

  test("only an ABSENT value defaults — null and 0 are values", () => {
    // `=== undefined` rather than `??`. A `??` would swallow a slot legitimately
    // holding `null`, and would put `get` and the projection on different rules
    // about the same slot, which surfaces as a tool and a projection seeing
    // different state for one session.
    const nullable = sessionSlot<"maybe", Cart | null>("maybe", () => emptyCart());
    const zero = sessionSlot("count", () => 7);
    const ctx = createToolContext();
    expect(nullable.set(ctx, null)).toBeNull();
    expect(nullable.get(ctx)).toBeNull();
    expect(zero.set(ctx, 0)).toBe(0);
    expect(zero.get(ctx)).toBe(0);
    expect(nullable.projection((v) => v)(null)).toBeNull();
  });

  describe("update", () => {
    test("hands the body a mutable draft and returns what it returned", () => {
      const ctx = createToolContext();
      const result = cartSlot.update(ctx, (cart) => {
        cart.items.push("apple");
        return cart.items.length;
      });
      expect(result).toBe(1);
      expect(cartSlot.get(ctx).items).toEqual(["apple"]);
    });

    test("is SYNCHRONOUS — the value is stored by the time it returns", () => {
      // Not a stylistic claim: it is what makes a read-modify-write atomic with
      // no lock, because the window cannot span another JS turn. A promise here
      // would mean callers had to await, and two that did not would interleave.
      const ctx = createToolContext();
      const returned: unknown = cartSlot.update(ctx, (cart) => cart.items.push("a"));
      expect(returned).toBe(1);
      expect(cartSlot.get(ctx).items).toEqual(["a"]);
    });

    test("installs the default on first use, like get", () => {
      const ctx = createToolContext();
      cartSlot.update(ctx, () => undefined);
      expect(ctx.slots.read("cart")).toEqual({ items: [], nextId: 1 });
    });

    test("the draft is a COPY — a mutation is invisible until the body returns", () => {
      const ctx = createToolContext();
      const before = cartSlot.get(ctx);
      cartSlot.update(ctx, (cart) => {
        cart.items.push("apple");
        // The stored value is still the pre-mutation one, which is what makes a
        // throwing mutator leave nothing half-applied.
        expect(before.items).toEqual([]);
      });
      expect(cartSlot.get(ctx).items).toEqual(["apple"]);
      expect(cartSlot.get(ctx)).not.toBe(before);
    });

    test("a throwing mutator stores NOTHING", () => {
      const ctx = createToolContext();
      cartSlot.update(ctx, (cart) => cart.items.push("first"));
      expect(() =>
        cartSlot.update(ctx, (cart) => {
          cart.items.push("second");
          throw new Error("boom");
        }),
      ).toThrow("boom");
      expect(cartSlot.get(ctx).items).toEqual(["first"]);
    });

    test("a throwing mutator does not wedge the slot", () => {
      const ctx = createToolContext();
      expect(() =>
        cartSlot.update(ctx, () => {
          throw new Error("boom");
        }),
      ).toThrow("boom");
      expect(cartSlot.update(ctx, (cart) => cart.items.length)).toBe(0);
    });

    test("refuses a nested update of the same slot", () => {
      // The nested write would be overwritten by the outer draft the moment the
      // outer mutator returned — a write that succeeds and then vanishes.
      const ctx = createToolContext();
      expect(() =>
        cartSlot.update(ctx, () => {
          cartSlot.update(ctx, (cart) => cart.items.push("x"));
        }),
      ).toThrow(/already open/);
    });

    test("refuses set and reset from inside the window", () => {
      const ctx = createToolContext();
      expect(() =>
        cartSlot.update(ctx, () => {
          cartSlot.set(ctx, emptyCart());
        }),
      ).toThrow(/cannot run inside/);
      expect(() =>
        cartSlot.update(ctx, () => {
          cartSlot.reset(ctx);
        }),
      ).toThrow(/cannot run inside/);
    });

    test("a DIFFERENT slot's update nests safely", () => {
      const flags = sessionSlot("flags", () => ({ seen: false }));
      const ctx = createToolContext();
      cartSlot.update(ctx, (cart) => {
        cart.items.push("apple");
        flags.update(ctx, (f) => {
          f.seen = true;
        });
      });
      expect(cartSlot.get(ctx).items).toEqual(["apple"]);
      expect(flags.get(ctx).seen).toBe(true);
    });

    test("one session's open window does not block another's", () => {
      const a = createToolContext();
      const b = createToolContext();
      cartSlot.update(a, () => {
        expect(cartSlot.update(b, (cart) => cart.items.push("b"))).toBe(1);
      });
      expect(cartSlot.get(b).items).toEqual(["b"]);
    });

    describe("the after hook", () => {
      const capped = sessionSlot("log", (): { entries: string[] } => ({ entries: [] }), {
        after: (value) => {
          value.entries = value.entries.slice(-2);
        },
      });

      test("runs on the draft after a successful mutation", () => {
        const ctx = createToolContext();
        capped.update(ctx, (log) => log.entries.push("a", "b", "c", "d"));
        expect(capped.get(ctx).entries).toEqual(["c", "d"]);
      });

      test("runs on every update, not only the first", () => {
        const ctx = createToolContext();
        capped.update(ctx, (log) => log.entries.push("a", "b", "c"));
        capped.update(ctx, (log) => log.entries.push("d", "e", "f"));
        expect(capped.get(ctx).entries).toEqual(["e", "f"]);
      });

      test("does NOT run when the mutator throws, and nothing is stored", () => {
        const ctx = createToolContext();
        // Typed rather than a bare `vi.fn()`: an untyped mock returns `any`, and
        // `RejectThenable<any>` resolves to the misuse message — the hook guard
        // cannot tell `any` from a promise, which is the correct side to err on.
        const after = vi.fn<(draft: { entries: string[] }) => void>();
        const slot = sessionSlot("hooked", (): { entries: string[] } => ({ entries: [] }), {
          after,
        });
        expect(() =>
          slot.update(ctx, (log) => {
            log.entries.push("a");
            throw new Error("mid-mutation");
          }),
        ).toThrow("mid-mutation");
        expect(after).not.toHaveBeenCalled();
        expect(slot.get(ctx).entries).toEqual([]);
      });

      test("a slot with no hook is unaffected", () => {
        const ctx = createToolContext();
        expect(cartSlot.update(ctx, (cart) => cart.items.length)).toBe(0);
      });
    });
  });

  describe("what a durable slot may hold", () => {
    // The check runs HERE, in the memory-backed store a spec uses, which is the
    // whole reason the memory backend is a valid double for the Postgres one: a
    // template holding a `Map` fails in its own spec rather than on the first
    // deployment that has a database.
    const holder = sessionSlot("held", (): { value: unknown } => ({ value: null }));

    test.each(UNSTORABLE)("refuses %s, naming the path", (_label, value, message) => {
      const ctx = createToolContext();
      expect(() =>
        holder.update(ctx, (held) => {
          held.value = value;
        }),
      ).toThrow(message);
      // And the path, so a failure says which field.
      expect(() =>
        holder.update(ctx, (held) => {
          held.value = value;
        }),
      ).toThrow(/held\.value/);
    });

    test("refuses a cycle", () => {
      const ctx = createToolContext();
      expect(() =>
        holder.update(ctx, (held) => {
          const cyclic: Record<string, unknown> = {};
          cyclic.self = cyclic;
          held.value = cyclic;
        }),
      ).toThrow(/circular reference/);
    });

    test("refuses undefined inside an array, which JSON turns into null", () => {
      const ctx = createToolContext();
      expect(() =>
        holder.update(ctx, (held) => {
          held.value = ["a", undefined];
        }),
      ).toThrow(/\[1\] is undefined/);
    });

    test("allows a present-but-undefined PROPERTY, which JSON drops", () => {
      const ctx = createToolContext();
      expect(() =>
        holder.update(ctx, (held) => {
          held.value = { a: 1, b: undefined };
        }),
      ).not.toThrow();
    });

    test("allows a shared subtree — a DAG is not a cycle", () => {
      // Regression: a single visited-set reported retail's seed catalogue as
      // circular, because two items share one `options` object.
      const ctx = createToolContext();
      const shared = { size: "M" };
      expect(() =>
        holder.update(ctx, (held) => {
          held.value = [{ options: shared }, { options: shared }];
        }),
      ).not.toThrow();
    });

    test("a VIRTUAL slot is neither checked nor frozen", () => {
      // What the escape hatch is for: a value whose lifetime is one call and
      // which could not be stored anyway — a handle, an open socket.
      const virtual = sessionSlot("scratch", () => ({ handle: new Map<string, number>() }), {
        durable: false,
      });
      expect(virtual.durable).toBe(false);
      const ctx = createToolContext();
      expect(() =>
        virtual.update(ctx, (scratch) => {
          scratch.handle.set("a", 1);
        }),
      ).not.toThrow();
      expect(Object.isFrozen(virtual.get(ctx))).toBe(false);
      expect(virtual.get(ctx).handle.get("a")).toBe(1);
    });
  });

  describe("projection", () => {
    const view = (cart: DeepReadonly<Cart>) => ({ count: cart.items.length });

    test("projects the stored value", () => {
      expect(cartSlot.projection(view)({ items: ["a", "b"], nextId: 3 })).toEqual({ count: 2 });
    });

    test("projects the default before anything is stored", () => {
      // What makes a client's empty-state fallback derivable from the projection
      // itself rather than hand-written — five templates hoist exactly this.
      expect(cartSlot.projection(view)()).toEqual({ count: 0 });
      expect(cartSlot.projection(view)(undefined)).toEqual({ count: 0 });
    });

    test("the projection sees a non-optional value", () => {
      // The callback's parameter is a real `Cart`, so a projection needs no
      // optional chaining. A type-level claim, asserted by dereferencing.
      expect(cartSlot.projection((cart) => cart.items.length)(undefined)).toBe(0);
    });

    test("carries the slot's key and default, which is what the runtime reads", () => {
      const projection = cartSlot.projection(view);
      expect(projection.key).toBe("cart");
      expect(projection.create()).toEqual({ items: [], nextId: 1 });
    });

    test("its default is minted per call, never a shared object", () => {
      const projection = cartSlot.projection(view);
      expect(projection.create()).not.toBe(projection.create());
    });
  });

  describe("tool", () => {
    const count = cartSlot.tool({
      description: "Count the items",
      inputSchema: z.object({}),
      execute: (_args, cart) => ({ count: cart.items.length }),
    });

    test("hands the body the stored value", async () => {
      const ctx = createToolContext();
      cartSlot.update(ctx, (cart) => cart.items.push("apple"));
      expect(await count.execute({}, ctx)).toEqual({ count: 1 });
    });

    test("what the body is handed is frozen, so a mutating READ tool throws", () => {
      const mutating = cartSlot.tool({
        description: "Wrongly mutates",
        execute: (_args, cart) => (cart as Cart).items.push("x"),
      });
      const ctx = createToolContext();
      // Thrown SYNCHRONOUSLY: a slot-backed tool body is not async, and neither
      // is the frozen write it attempts.
      expect(() => mutating.execute({}, ctx)).toThrow(TypeError);
    });

    test("carries description and inputSchema through unchanged", () => {
      expect(count.description).toBe("Count the items");
      expect(count.inputSchema).toBeDefined();
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
      const ctx = createToolContext();
      expect(await ping.execute({}, ctx)).toBe("sent");
      expect(ctx.sent).toEqual([{ event: "ping", data: { ok: true } }]);
    });
  });

  describe("updateTool", () => {
    const append = cartSlot.updateTool({
      description: "Append",
      inputSchema: z.object({ item: z.string() }),
      execute: ({ item }, cart) => {
        cart.items.push(item);
        return cart.items.length;
      },
    });

    test("hands the body a draft and stores what it leaves behind", async () => {
      const ctx = createToolContext();
      expect(await append.execute({ item: "a" }, ctx)).toBe(1);
      expect(cartSlot.get(ctx).items).toEqual(["a"]);
    });

    test("two concurrent calls cannot lose an append", async () => {
      // Real interleaving, which `Promise.all([execute(…), execute(…)])` cannot
      // produce: the bodies are enforced synchronous, so both would run to
      // completion during array-literal evaluation and the test would be the
      // sequential one above under another name. Both callers park on ONE gate
      // instead, so they are genuinely in flight together and each mutation
      // happens in its own JS turn — which is the shape the LLM loop produces,
      // since it runs a step's tool calls concurrently.
      //
      // Under a read-then-mutate across an await both would read length 0 and
      // the second write would win, giving `[1, 1]` and a one-item cart. The
      // window is synchronous, so the second body's draft is cloned from the
      // first body's committed value.
      const ctx = createToolContext();
      const gate = Promise.withResolvers<void>();
      const call = async (item: string): Promise<unknown> => {
        await gate.promise;
        return await append.execute({ item }, ctx);
      };
      const both = Promise.all([call("a"), call("b")]);
      gate.resolve();

      expect(await both).toEqual([1, 2]);
      expect(cartSlot.get(ctx).items).toEqual(["a", "b"]);
    });

    test("runs the slot's after hook", async () => {
      const capped = sessionSlot("capped", emptyCart, {
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
      const ctx = createToolContext();
      await add.execute({}, ctx);
      expect(capped.get(ctx).items).toEqual(["y", "z"]);
    });

    test("refuses an ASYNC body at DECLARATION, naming the rule", () => {
      // Its mutations would be committed at the end of the synchronous part and
      // the continuation would then write to a frozen draft — a `TypeError` from
      // somewhere unrelated. Enforced at run time because a conditional return
      // type cannot be satisfied by a generic wrapper (retail's `retailTool`) —
      // but at DECLARATION rather than on the first call, which is a caller on
      // the line. The module holding this is loaded by `aai dev`, by the build,
      // and by the agent's own spec.
      expect(() =>
        // @ts-expect-error - `RejectThenable` refuses this at COMPILE time now,
        // which is the point; the runtime guard stays because a generic wrapper
        // (retail's `retailTool`) and any JS caller still reach this path, and
        // this test is what keeps that guard covered.
        cartSlot.updateTool({
          description: "Awaits",
          execute: async (_args, cart) => {
            await Promise.resolve();
            cart.items.push("x");
          },
        }),
      ).toThrow(/must be synchronous, and this one is `async`/);
    });

    test("refuses a sync body that RETURNS a promise, on the call", () => {
      // The half the declaration check cannot see: this is an ordinary
      // function, so only the returned value gives it away.
      // @ts-expect-error - refused at compile time by `RejectThenable`; the
      // runtime check below is what a JS caller or a generic wrapper still
      // hits, so it stays covered.
      const bad = cartSlot.updateTool({
        description: "Returns a promise",
        execute: (_args, cart) => {
          cart.items.push("x");
          return Promise.resolve(1);
        },
      });
      const ctx = createToolContext();
      expect(() => bad.execute({}, ctx)).toThrow(/must be synchronous/);
    });

    test("propagates a throwing body without storing anything", () => {
      const boom = cartSlot.updateTool({
        description: "Boom",
        execute: (_args, cart) => {
          cart.items.push("x");
          throw new Error("nope");
        },
      });
      const ctx = createToolContext();
      expect(() => boom.execute({}, ctx)).toThrow("nope");
      expect(cartSlot.get(ctx).items).toEqual([]);
    });
  });

  test("two slots in one session stay independent", () => {
    const other = sessionSlot("flags", () => ({ seen: false }));
    const ctx = createToolContext();
    cartSlot.update(ctx, (cart) => cart.items.push("apple"));
    other.update(ctx, (flags) => {
      flags.seen = true;
    });
    expect(cartSlot.get(ctx)).toEqual({ items: ["apple"], nextId: 1 });
    expect(other.get(ctx)).toEqual({ seen: true });
  });
});

describe("one key, one slot", () => {
  test("refuses a second slot that reaches the same key in one session", () => {
    // `key`'s doc has always said two slots must not share one. Unchecked, a
    // slot typed `{ s: string }` was handed the `{ n: number }` another slot
    // wrote — the exact failure a typed seam exists to prevent, reached by a
    // name collision instead of a cast.
    const counts = sessionSlot("shared-key", () => ({ n: 0 }));
    const notes = sessionSlot("shared-key", () => ({ s: "" }));
    const ctx = createToolContext();
    counts.update(ctx, (value) => {
      value.n += 1;
    });
    expect(() => notes.get(ctx)).toThrow(
      /Two slots share the key "shared-key" in one session and disagree about what it holds: one stores \{n\}, the other \{s\}/,
    );
  });

  test("the SAME slot is fine however many times it is touched", () => {
    const slot = sessionSlot("solo", () => ({ n: 0 }));
    const ctx = createToolContext();
    slot.get(ctx);
    slot.update(ctx, (value) => {
      value.n += 1;
    });
    slot.set(ctx, { n: 5 });
    expect(slot.get(ctx)).toEqual({ n: 5 });
  });

  test("two declarations of the SAME shape share a key, which is how dialog() works", () => {
    // `dialog()` builds a slot per key, and one dialog written as a spec and
    // the same dialog written as a machine are interchangeable by design: they
    // occupy one key and store one snapshot shape. Only DISAGREEMENT is a bug.
    const one = sessionSlot("agreed", () => ({ snapshot: 1 }));
    const two = sessionSlot("agreed", () => ({ snapshot: 2 }));
    const ctx = createToolContext();
    one.set(ctx, { snapshot: 7 });
    expect(two.get(ctx)).toEqual({ snapshot: 7 });
  });

  test("two slots with the same key in DIFFERENT sessions never collide", () => {
    // The check is per store, which is what keeps a duplicate declaration in a
    // spec file, a template and a doc example from being an error — this repo
    // declares `sessionSlot("cart", …)` dozens of times, all correctly.
    const a = sessionSlot("same-name", () => ({ n: 0 }));
    const b = sessionSlot("same-name", () => ({ s: "" }));
    expect(a.get(createToolContext())).toEqual({ n: 0 });
    expect(b.get(createToolContext())).toEqual({ s: "" });
  });
});
