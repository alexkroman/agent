// Copyright 2026 the AAI authors. MIT license.
/**
 * Typed named slots — the one seam a multi-file agent needs to read and write
 * its own session state, and now the only thing that stores it.
 *
 * A slot used to be a property of `ctx.state`, one mutable bag per session. It
 * is not any more: `ctx.state` is gone, and a slot keeps its value in the
 * session-state store keyed by `(sessionId, slot key)` — see
 * `sdk/session-state.ts` for why, and `host/session-state-store.ts` for the two
 * backends. Nothing about authoring a slot changed; what changed is that the
 * framework can now see every write, which is what a durable value needs.
 *
 * @module session-slot
 */

import type { InferSchemaOutput, ToolInputSchema } from "./schema.ts";
import type { SlotStore, StateProjection } from "./session-state.ts";
import type { ToolContext, ToolDef } from "./types.ts";
import { isRecord } from "./utils.ts";

/**
 * The authoring shape of a slot-backed tool: {@link ToolDef} with the slot's
 * value handed to `execute` directly.
 *
 * `value` comes SECOND because it is what a slot-backed tool body actually
 * uses; most take `(args, cart)` and never mention `ctx` at all, which is the
 * point. Putting it there rather than third cannot be got wrong silently — a
 * body converted from `tool()` that still names its second parameter `ctx` is a
 * type error the first time it reads `ctx.env`, since `V` is not a
 * {@link ToolContext}.
 *
 * @typeParam V - What `execute` is handed: a frozen `Readonly<T>` from
 *   {@link SessionSlot.tool}, a mutable draft from
 *   {@link SessionSlot.updateTool}.
 *
 * @public
 */
export interface SlotToolDef<P extends ToolInputSchema, V, R> {
  /** See {@link ToolDef.description} — what the model reads to decide to call it. */
  description: string;
  /** See {@link ToolDef.inputSchema}. */
  inputSchema?: P;
  /** The tool body, handed this session's slot value alongside the usual args. */
  execute(args: InferSchemaOutput<P>, value: V, ctx: ToolContext): R;
}

/**
 * A named slot of per-session state, created by {@link sessionSlot}.
 *
 * @typeParam K - The key this slot occupies in the session's state.
 * @typeParam T - The value's shape.
 *
 * @public
 */
export interface SessionSlot<K extends string, T> {
  /** The store key this slot occupies. Two slots must not share one. */
  readonly key: K;
  /** A fresh default value, as `get` would install one. */
  create(): T;
  /**
   * Whether this slot's value is stored durably. `true` unless the slot
   * declared otherwise — see {@link SessionSlotOptions.durable}.
   */
  readonly durable: boolean;
  /**
   * This session's value, installing the default on first access.
   *
   * **Readonly, and frozen.** Mutating what this returns is a compile error,
   * and a `TypeError` for a caller with no types — because a mutation applied
   * here is applied to a value nothing is going to store. Every write goes
   * through {@link SessionSlot.update}.
   */
  get(ctx: ToolContext): Readonly<T>;
  /**
   * Mutate this session's value, and store the result.
   *
   * `mutate` is handed a mutable DRAFT — a private copy of the current value —
   * and whatever it leaves behind becomes the stored value when it returns.
   * Resolves to whatever `mutate` returned, so a tool body can compute its
   * result and its mutation in one pass.
   *
   * **It is SYNCHRONOUS, and that is the invariant, not an implementation
   * detail.** There is no await between the read and the write, so a
   * read-modify-write cannot interleave with another JS turn — which matters
   * because the LLM loop runs a step's tool calls CONCURRENTLY. Await in FRONT
   * of the mutation instead:
   *
   * ```ts
   * import { sessionSlot, tool } from "@alexkroman1/aai";
   * import { z } from "zod";
   *
   * const cartSlot = sessionSlot("cart", () => ({ items: [] as string[], quote: 0 }));
   *
   * export default tool({
   *   description: "Price the cart",
   *   inputSchema: z.object({}),
   *   execute: async (_args, ctx) => {
   *     const quote = await ctx.generate({ prompt: "price it" });   // await first
   *     return cartSlot.update(ctx, (cart) => {                     // then mutate
   *       cart.quote = Number(quote.text);
   *       return { quote: cart.quote };
   *     });
   *   },
   * });
   * ```
   *
   * A mutator that throws stores NOTHING: the draft is discarded and the
   * mutator's error propagates. The `after` hook does not run either — see
   * {@link SessionSlotOptions.after}.
   *
   * For serialized work that is not a slot mutation — an external resource, a
   * key that isn't the session id, or a mutation that must fail rather than
   * queue — reach for `createKeyedLock`/`withLock`. They are public for exactly
   * that, and this method no longer takes a lock at all: a synchronous window
   * has nothing to serialize.
   */
  update<R>(ctx: ToolContext, mutate: (draft: T) => R): R;
  /**
   * Replace this session's value wholesale (a load, an import, a restore), and
   * return it as `get` would.
   */
  set(ctx: ToolContext, value: T): Readonly<T>;
  /** Discard this session's value and install a fresh default, and return it. */
  reset(ctx: ToolContext): Readonly<T>;
  /**
   * Define a READ-ONLY tool over this slot: `execute` is handed the frozen
   * value, so the body needs neither a context annotation nor an opening
   * `slot.get(ctx)`.
   *
   * A body that mutates wants {@link SessionSlot.updateTool}. This one's value
   * is `Readonly<T>`, so choosing wrong is a compile error rather than a
   * write that goes nowhere.
   *
   * @example
   * ```ts
   * import { sessionSlot } from "@alexkroman1/aai";
   * import { z } from "zod";
   *
   * const cartSlot = sessionSlot("cart", () => ({ items: [] as string[] }));
   *
   * export default cartSlot.tool({
   *   description: "How many items are in the cart",
   *   inputSchema: z.object({}),
   *   execute: (_args, cart) => ({ count: cart.items.length }),
   * });
   * ```
   */
  tool<P extends ToolInputSchema = ToolInputSchema, R = unknown>(
    def: SlotToolDef<P, Readonly<T>, R>,
  ): ToolDef<P>;
  /**
   * Define a MUTATING tool over this slot: the body runs inside
   * {@link SessionSlot.update}, so it is handed a draft and whatever it leaves
   * behind is stored.
   *
   * The body must therefore be SYNCHRONOUS. A tool that has to await does the
   * awaiting in an ordinary `tool()` and calls `update` afterwards; see
   * `update`'s example.
   *
   * That is enforced at RUN TIME — a body returning a thenable throws naming the
   * rule — rather than in the type, and the reason is worth knowing before
   * "fixing" it: a conditional return type (`R extends Promise<unknown> ? never
   * : R`) cannot be satisfied by a generic WRAPPER around this method, and a
   * per-agent wrapper is the main way it gets used (`retail`'s `retailTool`).
   * The runtime check has the better message anyway, and it is the half a user's
   * project actually runs — neither bundler type-checks user code.
   *
   * @example
   * ```ts
   * import { sessionSlot } from "@alexkroman1/aai";
   * import { z } from "zod";
   *
   * const cartSlot = sessionSlot("cart", () => ({ items: [] as string[] }));
   *
   * export default cartSlot.updateTool({
   *   description: "Add an item to the cart",
   *   inputSchema: z.object({ item: z.string() }),
   *   execute: ({ item }, cart) => {
   *     cart.items.push(item);
   *     return { count: cart.items.length };
   *   },
   * });
   * ```
   */
  updateTool<P extends ToolInputSchema = ToolInputSchema, R = unknown>(
    def: SlotToolDef<P, T, R>,
  ): ToolDef<P>;
  /**
   * A `syncState` projection over this slot: read the value (defaulting when
   * the session has not touched it), then project.
   *
   * The result is CALLABLE as well as declarable, which is what lets a client
   * derive its own empty state from the same function the server pushes —
   * `slot.projection(view)()` is the pre-first-tool-call frame. Declaring it is
   * `agent({ syncState: slot.projection(view) })`, and an agent with more than
   * one slot passes an array; the frame carries the merge.
   *
   * `project` receives a REAL value, so a projection needs no optional chaining
   * for the moment before the first tool call.
   *
   * @example
   * ```ts
   * import { agent, sessionSlot } from "@alexkroman1/aai";
   *
   * const cartSlot = sessionSlot("cart", () => ({ items: [] as string[] }));
   *
   * export default agent({
   *   name: "Shop",
   *   syncState: cartSlot.projection((cart) => ({ count: cart.items.length })),
   * });
   * ```
   */
  projection<V>(project: (value: Readonly<T>) => V): StateProjection<V>;
}

/**
 * Options for {@link sessionSlot}.
 *
 * @public
 */
export interface SessionSlotOptions<T> {
  /**
   * Invariant restoration, run on the draft at the end of every successful
   * {@link SessionSlot.update} — pruning growth, recalculating a derived field.
   *
   * It exists so those rules live with the slot rather than being re-listed at
   * every mutating call site, which is how one gets forgotten. Because it runs
   * inside the mutation window, it sees the complete value about to be stored
   * and may mutate it in place.
   *
   * **It does NOT run when `mutate` throws.** A mutator that failed part-way
   * may have left the draft in a shape the hook itself cannot handle, and an
   * error thrown from the hook would replace the one that actually explains the
   * failure. Nothing is stored in that case either.
   */
  after?: (draft: T) => void;
  /**
   * Whether this slot's value is STORED. Defaults to `true`.
   *
   * `false` declares a VIRTUAL slot: a per-session box whose contents are
   * neither checked, frozen, nor committed, and which does not survive the
   * process. That is the right shape for a value whose lifetime is one call and
   * which could not be stored anyway — a provider handle, an open socket, a
   * cached client.
   *
   * It is a property of the slot's DECLARATION rather than a per-value opt-out,
   * which is what makes it a decision the author makes once instead of a check
   * somebody has to remember to skip. Note `get` on a virtual slot returns the
   * live value: there is nothing to protect it from, since nothing is going to
   * store a copy of it.
   */
  durable?: boolean;
}

/** Would `await` on this do anything? */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return isRecord(value) && typeof value.then === "function";
}

/**
 * Declare a named slot of per-session state.
 *
 * An agent whose tools live in separate modules has no other way to type its
 * own state: a tool is a FILE, so there is no map to check it against the
 * agent's state shape, and there is no bag to annotate. A slot moves that
 * narrowing into ONE typed seam every module imports, and the lazy install with
 * it — plus, now, the storage. Nothing else stores session state.
 *
 * {@link SessionSlot.tool} and {@link SessionSlot.updateTool} are the other
 * half: a tool declared through them is handed the value directly, so a tool
 * module needs neither an annotated context nor a `slot.get(ctx)` line.
 *
 * @param key - The store key to occupy. Two slots must not share one.
 * @param create - Factory for a fresh value. Called once per session on first
 *   access (and again on `reset`), so a shared module-level default must be
 *   cloned here — `() => structuredClone(DEFAULT)` — or every session mutates
 *   the same object.
 *
 * @example
 * ```ts
 * // shared.ts — the one place the slot is declared.
 * import { sessionSlot } from "@alexkroman1/aai";
 *
 * export type Cart = { items: string[] };
 * export const cartSlot = sessionSlot("cart", (): Cart => ({ items: [] }));
 * ```
 *
 * @example
 * ```ts no-check
 * // tools/add_item.ts — no cast, no annotation, no lazy-init boilerplate.
 * // (`no-check`: the point of the example is the OTHER file, so it cannot be
 * // self-contained.)
 * import { cartSlot } from "../shared.ts";
 * import { z } from "zod";
 *
 * export default cartSlot.updateTool({
 *   description: "Add an item to the cart",
 *   inputSchema: z.object({ item: z.string() }),
 *   execute: ({ item }, cart) => {
 *     cart.items.push(item);
 *     return { count: cart.items.length };
 *   },
 * });
 * ```
 *
 * @public
 */
export function sessionSlot<const K extends string, T>(
  key: K,
  create: () => T,
  options: SessionSlotOptions<T> = {},
): SessionSlot<K, T> {
  const durable = options.durable ?? true;
  const slots = (ctx: ToolContext): SlotStore => ctx.slots;

  /**
   * `=== undefined` and NOT `??`: only an absent value defaults. `??` would
   * also swallow a slot legitimately holding `null`, and would put `get` and
   * the projection on different rules about the same slot — the kind of
   * disagreement that surfaces as a projection and a tool seeing different
   * state.
   */
  const current = (ctx: ToolContext): T | undefined => {
    const existing = slots(ctx).read(key);
    return existing === undefined ? undefined : (existing as T);
  };

  /**
   * Sessions with a mutation window OPEN right now.
   *
   * A `set`, `reset` or nested `update` inside a window would be overwritten by
   * the draft the moment the outer mutator returned — a write that succeeds and
   * then vanishes, which is the exact failure class this whole change exists to
   * remove. `pizza-ordering` had one: its `resetOrder` helper called
   * `slot.set(ctx, …)` from inside a mutating tool body.
   *
   * Keyed by session, so two sessions never interfere, and per SLOT because the
   * closure is.
   */
  const open = new Set<string>();

  const store = (ctx: ToolContext, value: T): void => {
    slots(ctx).write(key, value, durable);
  };

  /** Refuse a direct write while a draft of the same slot is open. */
  const assertNoOpenDraft = (ctx: ToolContext, method: string): void => {
    if (!open.has(ctx.sessionId)) return;
    throw new Error(
      `${key}.${method}() cannot run inside ${key}.update() — the draft is stored when the mutator returns, so this write would be overwritten. Mutate the draft you were handed instead.`,
    );
  };

  const get = (ctx: ToolContext): Readonly<T> => {
    const existing = current(ctx);
    if (existing !== undefined) return existing as Readonly<T>;
    const value = create();
    store(ctx, value);
    return value as Readonly<T>;
  };

  /**
   * The private copy a mutation window works on.
   *
   * A durable slot's stored value is FROZEN and shared with every reader that
   * already called `get`, so the copy is what makes the window private — and what
   * makes a throwing mutator leave the stored value exactly as it was. A VIRTUAL
   * slot is handed the live value: it holds the things `structuredClone` cannot
   * copy, which is the reason it exists.
   */
  const copyForDraft = (value: T): T => (durable ? structuredClone(value) : value);

  const update = <R>(ctx: ToolContext, mutate: (draft: T) => R): R => {
    if (open.has(ctx.sessionId)) {
      throw new Error(
        `A mutation of the "${key}" slot is already open for this session. The value you were handed IS the draft — mutate that, and do not call set/reset/update on the same slot from inside it, because the draft is stored when the outer mutator returns and would overwrite it.`,
      );
    }
    const existing = current(ctx);
    // A fresh value needs no copy — nothing else has a reference to it yet.
    const draft = existing === undefined ? create() : copyForDraft(existing);
    open.add(ctx.sessionId);
    let result: R;
    try {
      result = mutate(draft);
      options.after?.(draft);
    } finally {
      // In `finally` so a throwing mutator does not wedge the slot for the rest
      // of the session. Nothing is stored on that path — see this method's doc.
      open.delete(ctx.sessionId);
    }
    store(ctx, draft);
    return result;
  };

  return {
    key,
    create,
    durable,
    get,
    update,
    set(ctx, value) {
      assertNoOpenDraft(ctx, "set");
      store(ctx, value);
      return value as Readonly<T>;
    },
    reset(ctx) {
      assertNoOpenDraft(ctx, "reset");
      const value = create();
      store(ctx, value);
      return value as Readonly<T>;
    },
    // Spreading the rest rather than restating `description`/`inputSchema`
    // keeps `inputSchema`'s optionality EXACTLY as declared — rebuilding it
    // field by field needs a spread ternary or an `omitUndefined` whose mapped
    // type cannot resolve against a still-generic `P`.
    tool: ({ execute, ...rest }) => ({
      ...rest,
      execute: (args, ctx) => execute(args, get(ctx), ctx),
    }),
    updateTool: ({ execute, ...rest }) => ({
      ...rest,
      execute: (args, ctx) =>
        update(ctx, (draft) => {
          const result = execute(args, draft, ctx);
          // An async body would have its mutations committed at the end of the
          // SYNCHRONOUS part and then go on mutating a frozen draft, which is a
          // `TypeError` from somewhere unrelated. Named here instead.
          if (isThenable(result)) {
            throw new Error(
              `The body of ${key}.updateTool must be synchronous — its mutations are committed when it returns, so an await inside it writes to a value that has already been stored. Do the awaiting in an ordinary tool() and call ${key}Slot.update afterwards.`,
            );
          }
          return result;
        }),
    }),
    projection(project) {
      const projection = (value?: unknown): ReturnType<typeof project> =>
        project((value === undefined ? create() : value) as Readonly<T>);
      // The slot's own `create` rather than a captured default: the runtime
      // calls this for a session that never touched the slot, and a shared
      // default object would then be projected — and, worse, be the thing a
      // later `update` cloned.
      return Object.assign(projection, { key, create: create as () => unknown });
    },
  };
}
