// Copyright 2026 the AAI authors. MIT license.
/**
 * `DeepReadonly<T>` — `Readonly<T>`, all the way down.
 *
 * Its own leaf module rather than a declaration inside `session-slot.ts`,
 * because ADOPTING it is what a slot's reading half asks of an agent's own
 * code: a domain helper that takes a slot read has to name this type, and it
 * should not have to import the slot machinery to do so. `session-slot.ts`
 * re-exports it, so `@alexkroman1/aai` is still where an author finds it.
 *
 * @module deep-readonly
 */

/**
 * `Readonly<T>`, all the way down.
 *
 * **The type a slot's reading half hands out, and the runtime it describes.**
 * `freezeStorable` (`sdk/session-state.ts`) walks a durable value on every
 * write and calls `Object.freeze` on every array and every nested object, so
 * the value a reader holds is deep-frozen and every mutation of it is a
 * `TypeError` in strict mode. `Readonly<T>` described only the top level, which
 * left the runtime STRICTER THAN THE TYPE — `game.inventory.push(item)` and
 * `game.flags[key] = true` both compiled, and both threw on the first call.
 * Two shipped templates did exactly that, in tools nothing in the repo ran.
 *
 * The cost is real and was the reason for the shallow type: a deep readonly
 * DOES propagate, because TypeScript ignores readonly modifiers on properties
 * in assignability but NOT on arrays — `readonly string[]` is not assignable to
 * `string[]`. So a domain helper an agent's own modules declare
 * (`orderTotal(cart: Cart)`) has to take `DeepReadonly<Cart>` (or its own
 * readonly shape) to keep accepting a slot read. That is a compile error where
 * the alternative is a `TypeError` at the first call in production, and it
 * points at the helper that would have mutated.
 *
 * Functions pass through untouched: a virtual slot (`durable: false`) is the
 * only one that can hold one, and nothing there is frozen.
 *
 * @public
 */
export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer E)[]
    ? readonly DeepReadonly<E>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;
