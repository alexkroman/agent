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

import { compileSlotCaps } from "./_session-slot-caps.ts";
import { claimKey, type KeyOwner, shapeOf } from "./_slot-owners.ts";
import type { DeepReadonly } from "./deep-readonly.ts";
import { isRecord } from "./is-record.ts";
import type { ToolInputSchema } from "./schema.ts";
import type { SessionSlot } from "./session-slot-handle.ts";
import type { SessionSlotOptions, SlotToolDef } from "./session-slot-types.ts";
import type { SlotHolder, SlotStore, StateProjection } from "./session-state.ts";

// Re-exported rather than defined here: it is the type of what `get` hands
// back, so it belongs beside `sessionSlot` on the root barrel — and it is its
// OWN module so an agent's domain helper can name it without importing the
// slot machinery, which is exactly what adopting it asks every such helper to
// do (see the type's own doc).
export type { DeepReadonly } from "./deep-readonly.ts";
// The HANDLE this factory answers with, in its own module for the reason
// `sdk/dialog-handle.ts` is — see that file's doc. Re-exported here so
// `@alexkroman1/aai` and a reader who looks for it where `sessionSlot` is both
// still find it in one place.
export type { SessionSlot } from "./session-slot-handle.ts";
// The types a CALLER writes live in their own module (this file was at the
// 500-line cap) and are re-exported here, so `@alexkroman1/aai` — and a reader
// who looks for them where `sessionSlot` is — still finds them in one place.
export type { SessionSlotOptions, SlotCaps, SlotToolDef } from "./session-slot-types.ts";
// The seam every one of the handle's methods takes. Re-exported here for the
// reason `DeepReadonly` is: a caller writing a helper around a slot names it,
// and it should be findable where `sessionSlot` is.
export type { SlotHolder } from "./session-state.ts";

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
 * @param options - See {@link SessionSlotOptions}. `view` is the one worth
 *   knowing about up front: it declares what the BROWSER sees, so
 *   {@link SessionSlot.projected} is the one object `agent({ syncState })` and
 *   `useAgentState` both take.
 *
 * @example
 * ```ts
 * // shared.ts — the one place the slot is declared, view included.
 * import { sessionSlot } from "@alexkroman1/aai";
 *
 * export type Cart = { items: string[] };
 * export const cartSlot = sessionSlot("cart", (): Cart => ({ items: [] }), {
 *   view: (cart) => ({ count: cart.items.length }),
 * });
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
export function sessionSlot<const K extends string, T, After = void, V = DeepReadonly<T>>(
  key: K,
  create: () => T,
  options: SessionSlotOptions<T, After, V> = {},
): SessionSlot<K, T, V> {
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
   * remove. `pizza-ordering-agent` had one: its `resetOrder` helper called
   * `slot.set(ctx, …)` from inside a mutating tool body.
   *
   * Keyed by session, so two sessions never interfere, and per SLOT because the
   * closure is.
   */
  const open = new Set<string>();

  // Validated at declaration; see `_session-slot-caps.ts`. Applied in `store`,
  // which every writer goes through, so the ordering `SessionSlotOptions.caps`
  // promises — after `after`, before the freeze — falls out of the one place
  // rather than being remembered per method.
  const applyCaps = compileSlotCaps<T>(key, options.caps);

  const store = (ctx: SlotHolder, value: T): void => {
    slots(ctx).write(key, applyCaps(value), durable);
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

  /**
   * One projection over this slot, for both {@link SessionSlot.projection} and
   * the declared `projected` below.
   *
   * A named function rather than the method body, so `projected` can be built
   * from the SAME code path at declaration time. That is the whole point of the
   * field: one object, handed to `syncState` and to `useAgentState`, rather than
   * an expression composed once per end.
   */
  const project = <P>(view: (value: DeepReadonly<T>) => P): StateProjection<P> => {
    // `applyCaps` on the default too: a stored value never exceeds its caps,
    // and the frame rendered before the first tool call should not either.
    const projection = (value?: unknown): P =>
      view((value === undefined ? applyCaps(create()) : value) as DeepReadonly<T>);
    // The slot's own `create` rather than a captured default: the runtime
    // calls this for a session that never touched the slot, and a shared
    // default object would then be projected — and, worse, be the thing a
    // later `update` cloned.
    return Object.assign(projection, { key, create: create as () => unknown });
  };

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
    // Built HERE, at declaration, which is the field's whole guarantee: one
    // object for the life of the module, so the two ends pass the same
    // projection and `useAgentState` memoizes one empty frame off its identity.
    //
    // The identity view is what a slot that declared none projects — the whole
    // value, which is what `slot.projection((value) => value)` already spelled
    // by hand — and `projected` is total rather than conditionally present so
    // that "no view" has to mean something. The assertion is this file's
    // existing seam (see `update` above): with no `view`, `V` really is its own
    // default (`DeepReadonly<T>`), but the `??` widens the inferred projection
    // to the union of both arms and nothing at this position narrows it back.
    projected: project<V | DeepReadonly<T>>(options.view ?? ((value) => value)) as SessionSlot<
      K,
      T,
      V
    >["projected"],
    projection: project,
  };
}
