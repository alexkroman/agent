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

import { claimKey, type KeyOwner, shapeOf } from "./_slot-owners.ts";
import type { DeepReadonly } from "./deep-readonly.ts";
import { isRecord } from "./is-record.ts";
import type { ToolInputSchema } from "./schema.ts";
import type {
  RejectThenable,
  RejectThenableResult,
  SessionSlotOptions,
  SlotToolDef,
} from "./session-slot-types.ts";
import type { SlotHolder, SlotStore, StateProjection } from "./session-state.ts";
import type { ToolDef } from "./types.ts";

// Re-exported rather than defined here: it is the type of what `get` hands
// back, so it belongs beside `sessionSlot` on the root barrel — and it is its
// OWN module so an agent's domain helper can name it without importing the
// slot machinery, which is exactly what adopting it asks every such helper to
// do (see the type's own doc).
export type { DeepReadonly } from "./deep-readonly.ts";
// The two types a CALLER writes live in their own module (this file was at the
// 500-line cap) and are re-exported here, so `@alexkroman1/aai` — and a reader
// who looks for them where `sessionSlot` is — still finds them in one place.
export type { SessionSlotOptions, SlotToolDef } from "./session-slot-types.ts";
// The seam every method above takes. Re-exported here for the reason
// `DeepReadonly` is: a caller writing a helper around a slot names it, and it
// should be findable where `sessionSlot` is.
export type { SlotHolder } from "./session-state.ts";

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
   * **Readonly all the way down, and frozen to match.** Mutating what this
   * returns is a compile error at every depth — `cart.items.push(x)` as much as
   * `cart.total = 0` — and a `TypeError` for a caller with no types, because a
   * mutation applied here is applied to a value nothing is going to store.
   * Every write goes through {@link SessionSlot.update}. See
   * {@link DeepReadonly} for why the type is deep rather than shallow.
   */
  get(ctx: SlotHolder): DeepReadonly<T>;
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
  update<R>(ctx: SlotHolder, mutate: (draft: T) => R): RejectThenableResult<R>;
  /**
   * Replace this session's value wholesale (a load, an import, a restore), and
   * return it as `get` would.
   *
   * **The caller's object is COPIED, not adopted.** A durable slot freezes what
   * it stores, and this method's own examples — a load, an import, a restore —
   * are exactly the cases where the caller still holds a reference to what it
   * passed: freezing in place turned an unrelated later line
   * (`imported.items.push(...)`) into a `TypeError` from a stack that names
   * nothing about this slot. {@link SessionSlot.update} was already safe because
   * its draft is a copy; this is the same rule applied to the other writer.
   */
  set(ctx: SlotHolder, value: T): DeepReadonly<T>;
  /** Discard this session's value and install a fresh default, and return it. */
  reset(ctx: SlotHolder): DeepReadonly<T>;
  /**
   * Define a READ-ONLY tool over this slot: `execute` is handed the frozen
   * value, so the body needs neither a context annotation nor an opening
   * `slot.get(ctx)`.
   *
   * A body that mutates wants {@link SessionSlot.updateTool}. This one's value
   * is {@link DeepReadonly}`<T>`, so choosing wrong is a compile error — at any
   * depth — rather than a write that goes nowhere or throws.
   *
   * **`R` is threaded out**, as {@link tool}'s is: `R` used to be bound here and
   * thrown away at the interface, so `InferToolOutput` answered `unknown` for
   * exactly the tools an agent most often writes. Narrowing a return type is
   * covariant, so the tool stays assignable to `ToolDef<ToolInputSchema>`.
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
    def: SlotToolDef<P, DeepReadonly<T>, R>,
  ): ToolDef<P, R>;
  /**
   * Define a MUTATING tool over this slot: the body runs inside
   * {@link SessionSlot.update}, so it is handed a draft and whatever it leaves
   * behind is stored.
   *
   * The body must therefore be SYNCHRONOUS. A tool that has to await does the
   * awaiting in an ordinary `tool()` and calls `update` afterwards; see
   * `update`'s example.
   *
   * That is enforced at RUN TIME rather than in the type, and the reason is
   * worth knowing before "fixing" it: a conditional return type
   * (`R extends Promise<unknown> ? never : R`) cannot be satisfied by a generic
   * WRAPPER around this method, and a per-agent wrapper is the main way it gets
   * used (`retail`'s `retailTool`). The runtime check has the better message
   * anyway, and it is the half a user's project actually runs — neither bundler
   * type-checks user code.
   *
   * **It fires at DECLARATION for the common case.** An `async` body is an
   * `AsyncFunction`, visible the moment the module loads — under `aai dev`, in
   * the build, in the agent's own spec. A sync function that RETURNS a promise
   * is the other half, and only the call can catch it.
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
    def: SlotToolDef<P, T, R> & RejectThenable<R>,
  ): ToolDef<P, R>;
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
  projection<V>(project: (value: DeepReadonly<T>) => V): StateProjection<V>;
}

/** Would `await` on this do anything? */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return isRecord(value) && typeof value.then === "function";
}

/**
 * The refusal an asynchronous `updateTool` body earns, in one place.
 *
 * Both arms — the `async` DECLARATION and the sync function that RETURNS a
 * thenable — say the same thing and had drifted: one told the author to "call
 * the slot's update()", the other to call `${key}Slot.update`, inventing a
 * `Slot` suffix the key does not carry.
 *
 * @param how - What the caller did, appended to "must be synchronous".
 */
function mustBeSync(key: string, how: string): Error {
  return new Error(
    `The body of ${key}.updateTool must be synchronous${how} — its mutations are committed when it returns, so an await inside it writes to a value that has already been stored. Do the awaiting in an ordinary tool() and call the slot's update() afterwards.`,
  );
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
 * @param key - The store key to occupy. Two slots must not share one, and
 *   `claimKey` enforces it per session: two slots on one key that DISAGREE
 *   about the shape they store are refused the moment the second one is
 *   touched, since each would be reading and writing the other's value.
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
export function sessionSlot<const K extends string, T, After = void>(
  key: K,
  create: () => T,
  options: SessionSlotOptions<T, After> = {},
): SessionSlot<K, T> {
  const durable = options.durable ?? true;
  /**
   * This slot's identity, for the ownership check in {@link claimKey}. The slot
   * object itself is built below and cannot be referenced yet; a token needs no
   * more than to be unique per declaration.
   */
  const identity = {};
  const claim: KeyOwner = { owner: identity, shape: () => shapeOf(create) };
  const slots = (ctx: SlotHolder): SlotStore => {
    claimKey(ctx.slots, key, claim);
    return ctx.slots;
  };

  /**
   * `=== undefined` and NOT `??`: only an absent value defaults. `??` would
   * also swallow a slot legitimately holding `null`, and would put `get` and
   * the projection on different rules about the same slot — the kind of
   * disagreement that surfaces as a projection and a tool seeing different
   * state.
   */
  const current = (ctx: SlotHolder): T | undefined => {
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

  const store = (ctx: SlotHolder, value: T): void => {
    slots(ctx).write(key, value, durable);
  };

  /** Refuse a direct write while a draft of the same slot is open. */
  const assertNoOpenDraft = (ctx: SlotHolder, method: string): void => {
    if (!open.has(ctx.sessionId)) return;
    throw new Error(
      `${key}.${method}() cannot run inside ${key}.update() — the draft is stored when the mutator returns, so this write would be overwritten. Mutate the draft you were handed instead.`,
    );
  };

  const get = (ctx: SlotHolder): DeepReadonly<T> => {
    const existing = slots(ctx).read(key);
    if (existing !== undefined) return existing as DeepReadonly<T>;
    const value = create();
    store(ctx, value);
    return frozen(value);
  };

  /**
   * A value this slot has just stored, as `get` describes it.
   *
   * The cast is the seam between the runtime guarantee and the type: `store`
   * hands a durable value to `freezeStorable`, which deep-freezes it, so what
   * comes back really is readonly at every depth — but only the freeze knows
   * that, and a generic `T` cannot be narrowed to `DeepReadonly<T>` by
   * inference. One function rather than a cast per return, so there is one
   * place to read that argument.
   */
  const frozen = (value: T): DeepReadonly<T> => value as DeepReadonly<T>;

  /**
   * The private copy this slot works on, for both of its writers.
   *
   * A durable slot's stored value is FROZEN and shared with every reader that
   * already called `get`, so the copy is what makes an `update` window private —
   * and what makes a throwing mutator leave the stored value exactly as it was.
   * `set` needs it for the mirror-image reason: without a copy it freezes the
   * CALLER's own object, and the caller of a load/import/restore is precisely
   * the one still holding a reference to it. A VIRTUAL slot is handed the live
   * value: it holds the things `structuredClone` cannot copy, which is the
   * reason it exists, and nothing freezes it.
   */
  const privateCopy = (value: T): T => (durable ? structuredClone(value) : value);

  const update = <R>(ctx: SlotHolder, mutate: (draft: T) => R): R => {
    if (open.has(ctx.sessionId)) {
      throw new Error(
        `A mutation of the "${key}" slot is already open for this session. The value you were handed IS the draft — mutate that, and do not call set/reset/update on the same slot from inside it, because the draft is stored when the outer mutator returns and would overwrite it.`,
      );
    }
    const existing = current(ctx);
    // A fresh value needs no copy — nothing else has a reference to it yet.
    const draft = existing === undefined ? create() : privateCopy(existing);
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
    // The public signature answers `RejectThenableResult<R>`, an authoring
    // guard the implementation has no way to satisfy generically — at run time
    // it hands back exactly what the mutator returned, which is `R` on every
    // path the guard permits.
    update: update as SessionSlot<K, T>["update"],
    set(ctx, value) {
      assertNoOpenDraft(ctx, "set");
      // A copy, so the freeze lands on the slot's own object rather than on the
      // caller's — see this method's doc on the interface above.
      const stored = privateCopy(value);
      store(ctx, stored);
      return frozen(stored);
    },
    reset(ctx) {
      assertNoOpenDraft(ctx, "reset");
      // No copy: `create()` is a fresh value nothing else has a reference to.
      const value = create();
      store(ctx, value);
      return frozen(value);
    },
    // Spreading the rest rather than restating `description`/`inputSchema`
    // keeps `inputSchema`'s optionality EXACTLY as declared — rebuilding it
    // field by field needs a spread ternary or an `omitUndefined` whose mapped
    // type cannot resolve against a still-generic `P`.
    tool: ({ execute, ...rest }) => ({
      ...rest,
      execute: (args, ctx) => execute(args, get(ctx), ctx),
    }),
    // The public signature intersects `RejectThenable<R>` into `def`, which is
    // an authoring guard and not a shape this body can destructure — spreading
    // the rest off an intersection with `unknown` loses `inputSchema`'s
    // optionality. Narrow to the plain def here; the guard has already done its
    // work at the call site.
    updateTool: (({ execute, ...rest }: SlotToolDef<ToolInputSchema, T, unknown>) => {
      // At DECLARATION, where the overwhelming majority of this mistake is
      // visible. The check below still stands for a sync function that RETURNS
      // a promise, which only the call can see.
      if (execute.constructor?.name === "AsyncFunction") {
        throw mustBeSync(key, ", and this one is `async`");
      }
      return {
        ...rest,
        execute: (args, ctx) =>
          update(ctx, (draft) => {
            const result = execute(args, draft, ctx);
            // The half the declaration-time check cannot see. Its mutations
            // would be committed at the end of the synchronous part and it
            // would then mutate a frozen draft — a `TypeError` from somewhere
            // unrelated. Named here instead.
            if (isThenable(result)) {
              throw mustBeSync(key, "");
            }
            return result;
          }),
      };
    }) as SessionSlot<K, T>["updateTool"],
    projection(project) {
      const projection = (value?: unknown): ReturnType<typeof project> =>
        project((value === undefined ? create() : value) as DeepReadonly<T>);
      // The slot's own `create` rather than a captured default: the runtime
      // calls this for a session that never touched the slot, and a shared
      // default object would then be projected — and, worse, be the thing a
      // later `update` cloned.
      return Object.assign(projection, { key, create: create as () => unknown });
    },
  };
}
