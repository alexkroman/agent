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
import {
  assertSynchronous,
  buildSlotTool,
  buildUpdateTool,
  type ErasedSlotToolDef,
  type ErasedUpdateToolDef,
  type SendOptions,
  type SlotCore,
  transactSlot,
} from "./_slot-tools.ts";
import { registerSyncedProjection } from "./_sync-registry.ts";
import type { DeepReadonly } from "./deep-readonly.ts";
import type { SessionSlot } from "./session-slot-handle.ts";
import type { SessionSlotOptions } from "./session-slot-types.ts";
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
// still find it in one place. `SlotValueOf`/`SlotDraftOf` read a value's two
// types off a handle, so they are beside it.
export type {
  GatedOutput,
  SessionSlot,
  SlotDraftOf,
  SlotValueOf,
} from "./session-slot-handle.ts";
// The types a CALLER writes live in their own module (this file was at the
// 500-line cap) and are re-exported here, so `@alexkroman1/aai` — and a reader
// who looks for them where `sessionSlot` is — still finds them in one place.
export type {
  SessionSlotOptions,
  SlotCaps,
  SlotDialogGate,
  SlotPreparedToolDef,
  SlotToolDef,
  SlotTransaction,
  SlotUpdateToolDef,
} from "./session-slot-types.ts";
// The seam every one of the handle's methods takes. Re-exported here for the
// reason `DeepReadonly` is: a caller writing a helper around a slot names it,
// and it should be findable where `sessionSlot` is.
export type { SlotHolder } from "./session-state.ts";

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
 * @param create - A fresh value: a FACTORY, called once per session on first
 *   access (and again on `reset`), or the plain VALUE, which the slot
 *   `structuredClone`s on every install so no two sessions share it. A shared
 *   module-level default therefore no longer needs the
 *   `() => structuredClone(DEFAULT)` wrapper — pass `DEFAULT`. A slot whose
 *   value IS a function (a virtual slot holding a callback) must use the
 *   factory form, since a function argument is read as one.
 * @param options - See {@link SessionSlotOptions}. `view` is the one worth
 *   knowing about up front: it declares what the BROWSER sees, so
 *   {@link SessionSlot.projected} is the one object `agent({ syncState })` and
 *   `useAgentState` both take; `sync: true` hands it to `agent()` for you.
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
  create: T | (() => T),
  options: SessionSlotOptions<T, After, V> = {},
): SessionSlot<K, T, V> {
  const durable = options.durable ?? true;
  // The factory the rest of this function works with. A plain value is cloned
  // per install, which is the wrapper every template wrote by hand and the one
  // an author forgets — `() => DEFAULT` hands every session the same object.
  const make: () => T =
    typeof create === "function" ? (create as () => T) : () => structuredClone(create);
  /**
   * This slot's identity, for the ownership check in {@link claimKey}. The slot
   * object itself is built below and cannot be referenced yet; a token needs no
   * more than to be unique per declaration.
   */
  const identity = {};
  const claim: KeyOwner = { owner: identity, shape: () => shapeOf(make) };
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
    slots(ctx).write(key, applyCaps(value), { durable });
  };

  /**
   * The `after` hook over a value about to be stored OUTSIDE a mutation window
   * — a fresh default, `set`'s copy, the projection's empty frame. `update`
   * calls the hook itself, inside its window. Every path then meets `caps` in
   * `store`, which is the ordering `SessionSlotOptions.caps` promises.
   */
  const settled = (value: T): T => {
    options.after?.(value);
    return value;
  };

  /** A fresh default, hook applied: what `get` and `reset` install. */
  const install = (): T => settled(make());

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
    const value = install();
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

  /** The projection over this slot that `projected` below is built from. */
  const project = <P>(view: (value: DeepReadonly<T>) => P): StateProjection<P> => {
    // The hook and `applyCaps` on the empty frame too: a stored value is
    // always hooked and never exceeds its caps, and the frame rendered before
    // the first tool call should describe the same shape. `empty` is the
    // seeded slot's blank, so a seed never ships to the browser.
    const blank = (): T =>
      applyCaps(settled(options.empty === undefined ? make() : options.empty()));
    const projection = (value?: unknown): P =>
      view((value === undefined ? blank() : value) as DeepReadonly<T>);
    // The slot's own factory rather than a captured default: the runtime
    // calls this for a session that never touched the slot, and a shared
    // default object would then be projected — and, worse, be the thing a
    // later `update` cloned.
    return Object.assign(projection, { key, create: make as () => unknown });
  };

  const update = <R>(ctx: SlotHolder, mutate: (draft: T) => R): R => {
    if (open.has(ctx.sessionId)) {
      throw new Error(
        `A mutation of the "${key}" slot is already open for this session. The value you were handed IS the draft — mutate that, and do not call set/reset/update on the same slot from inside it, because the draft is stored when the outer mutator returns and would overwrite it.`,
      );
    }
    const existing = current(ctx);
    // A fresh value needs no copy — nothing else has a reference to it yet.
    // Unhooked: `after` runs on the draft at the end of this window.
    const draft = existing === undefined ? make() : privateCopy(existing);
    open.add(ctx.sessionId);
    let result: R;
    try {
      result = mutate(draft);
      assertSynchronous(key, result, "update");
      options.after?.(draft);
    } finally {
      // In `finally` so a throwing mutator does not wedge the slot for the rest
      // of the session. Nothing is stored on that path — see this method's doc.
      open.delete(ctx.sessionId);
    }
    store(ctx, draft);
    return result;
  };

  // What the tool builders in `_slot-tools.ts` need of this slot: the key, a
  // frozen read, and the window. They never touch the store directly.
  const core: SlotCore<T> = { key, get, update };

  // Built HERE, at declaration, which is the field's whole guarantee: one
  // object for the life of the module, so the two ends pass the same
  // projection and `useAgentState` memoizes one empty frame off its identity.
  //
  // The identity view is what a slot that declared none projects — the whole
  // value — and `projected` is total rather than conditionally present so
  // that "no view" has to mean something. The assertion is this file's
  // existing seam (see `update` above): with no `view`, `V` really is its own
  // default (`DeepReadonly<T>`), but the `??` widens the inferred projection
  // to the union of both arms and nothing at this position narrows it back.
  const projected = project<V | DeepReadonly<T>>(options.view ?? ((value) => value)) as SessionSlot<
    K,
    T,
    V
  >["projected"];
  // At declaration, so `agent()` — which runs when `agent.ts` is evaluated,
  // after the modules it imports — finds it. See `SessionSlotOptions.sync`.
  if (options.sync === true) registerSyncedProjection(projected);

  return {
    key,
    create: make,
    durable,
    get,
    // `get` hands back the stored (frozen) value itself, so this is always a
    // real copy, durable or not — the one case `privateCopy` skips.
    snapshot: (ctx) => structuredClone(get(ctx)) as T,
    // The public signature answers `RejectThenableResult<R>`, an authoring
    // guard the implementation has no way to satisfy generically — at run time
    // it hands back exactly what the mutator returned, which is `R` on every
    // path the guard permits.
    update: update as SessionSlot<K, T>["update"],
    set(ctx, value) {
      assertNoOpenDraft(ctx, "set");
      // A copy, so the freeze lands on the slot's own object rather than on the
      // caller's — see this method's doc on the interface above. Hooked, so a
      // loaded value meets the same invariants an updated one does.
      const stored = settled(privateCopy(value));
      store(ctx, stored);
      return frozen(stored);
    },
    reset(ctx) {
      assertNoOpenDraft(ctx, "reset");
      // No copy: a fresh default is a value nothing else has a reference to.
      const value = install();
      store(ctx, value);
      return frozen(value);
    },
    // The public signatures are OVERLOADS over the stages a def declares (gate,
    // `prepare`, `report`), each intersected with authoring guards
    // (`RejectThenable`) this body cannot destructure generically. The
    // builders read one erased shape; the cast is the seam between the
    // overloads and that shape, made once per method.
    tool: ((def: ErasedSlotToolDef<T>, options?: SendOptions) =>
      buildSlotTool(core, def, options)) as SessionSlot<K, T, V>["tool"],
    updateTool: ((def: ErasedUpdateToolDef<T>, options?: SendOptions) =>
      buildUpdateTool(core, def, options)) as SessionSlot<K, T, V>["updateTool"],
    transact: (ctx, tx) => transactSlot(core, ctx, tx),
    projected,
  };
}
