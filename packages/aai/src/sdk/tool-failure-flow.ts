// Copyright 2026 the AAI authors. MIT license.
/**
 * Forwarding a {@link ToolFailure} out of a chain of lookups, without writing
 * the forward at every step.
 *
 * `T | ToolFailure` is this SDK's Result: a helper answers with the thing or
 * with a sentence the model can recover from, and its caller passes the failure
 * along unchanged. The pattern is right; what is tedious is that the passing
 * along is a statement per lookup, and shipped templates carry **48** of them:
 *
 * ```ts
 * import { failable, isToolFailure, orFail, type ToolFailure } from "@alexkroman1/aai";
 *
 * type Store = { orders: Record<string, Order> };
 * type User = { id: string };
 * type Order = { id: string; total: number };
 * type Plan = { order: Order; diff: number };
 *
 * declare function authenticatedUser(state: Store): User | ToolFailure;
 * declare function resolveOrder(state: Store, spoken: string): Order | ToolFailure;
 * declare function planItemSwap(user: User, order: Order): Plan | ToolFailure;
 *
 * function planSwapByHand(state: Store, spokenId: string): Plan | ToolFailure {
 *   const user = authenticatedUser(state);
 *   if (isToolFailure(user)) return user;
 *   const order = resolveOrder(state, spokenId);
 *   if (isToolFailure(order)) return order;
 *   const plan = planItemSwap(user, order);
 *   if (isToolFailure(plan)) return plan;
 *   return plan;
 * }
 *
 * // The same function with the forwarding written once:
 * const planSwap = failable((state: Store, spokenId: string): Plan => {
 *   const user = orFail(authenticatedUser(state));
 *   const order = orFail(resolveOrder(state, spokenId));
 *   return orFail(planItemSwap(user, order));
 * });
 * ```
 *
 * Half the lines of the first say nothing about the domain, and each one names
 * its variable twice — so `if (isToolFailure(order)) return user;` reads as
 * noise rather than as the bug it is.
 *
 * ## Three things it is deliberately NOT
 *
 * **It is not a change to how a tool reports failure.** `failable` answers
 * `R | ToolFailure` — the same union, returned the same way. Nothing in the
 * runtime knows this exists, no runner had to learn a new error type, and a
 * function not wrapped in `failable` behaves exactly as before.
 *
 * **It is not a general exception facility.** The sentinel is a private class
 * and {@link failable} catches only that: every other throw passes through
 * untouched, so a `TypeError` in a wrapped body still reaches the tool executor
 * and is still reported as a tool that threw. `orFail` outside a `failable` is
 * therefore a bug that behaves like one — an escaping throw — rather than one
 * that silently swallows.
 *
 * **It is not for `slot.update` bodies that have already written.** A mutator
 * that RETURNS a failure keeps the mutations it made before returning; one that
 * THROWS stores nothing (`session-slot.ts` makes that promise deliberately).
 * `orFail` throws, so inside an `update` window it discards the draft. That is
 * usually what you want and is occasionally not — reach for it where the guard
 * comes before the writing.
 *
 * ## When it PAYS, measured on the templates
 *
 * The wrapper is three lines when it has to be introduced (`update(ctx,
 * failable((state) => {`, and the closing `}))`), and each guard it removes is
 * one. So the arithmetic is simply whether the function is already a
 * declaration:
 *
 * - **A named helper returning `T | ToolFailure`** — `retail-orders-agent`'s `planModifyItems`,
 *   `planExchange`, `assertCanCoverDiff` — pays immediately. `failable` replaces
 *   the `function` keyword, so it costs nothing and every guard is a line saved.
 *   Nine guards became three `orFail`s there.
 * - **An inline `slot.update` mutator with one or two guards** does NOT.
 *   `emergency-dispatch-agent`'s six tools were converted and reverted: the wrapper cost
 *   more than the guards it removed, and the plain
 *   `if (isToolFailure(inc)) return inc;` is a perfectly good first line of a
 *   body. There is no rule here that a chain of two lookups needs this.
 *
 * @module
 */

import { isToolFailure, type ToolFailure } from "./utils.ts";

/**
 * The private throw {@link orFail} uses to reach its {@link failable}.
 *
 * Not exported, and that is the containment: nothing outside this module can
 * mint one, so `failable` catching it cannot catch anything an author threw for
 * another reason. It carries the failure rather than a message, so the object
 * the helper built — its exact sentence — is what comes back out.
 */
class ToolFailureSignal extends Error {
  readonly failure: ToolFailure;
  constructor(failure: ToolFailure) {
    super(failure.error);
    this.name = "ToolFailureSignal";
    this.failure = failure;
  }
}

/**
 * The value, or abandon the surrounding {@link failable} with the failure.
 *
 * @throws A private sentinel, caught by the enclosing {@link failable}. Calling
 * it outside one is a programming error and behaves like one — the throw
 * escapes and the tool executor reports it — rather than being silently
 * swallowed.
 *
 * @example
 * ```ts
 * import { failable, orFail, type ToolFailure } from "@alexkroman1/aai";
 *
 * type Order = { id: string; total: number };
 * declare function findOrder(id: string): Order | ToolFailure;
 *
 * const orderTotal = failable((id: string) => orFail(findOrder(id)).total);
 * // orderTotal("A1") is number | ToolFailure
 * ```
 *
 * @public
 */
export function orFail<T>(value: T | ToolFailure): T {
  if (isToolFailure(value)) throw new ToolFailureSignal(value);
  // `value` is `T | ToolFailure` minus the ToolFailure branch, which TypeScript
  // cannot subtract from an unresolved generic — negating a type predicate does
  // not narrow one. The guard above is the proof.
  return value as T;
}

/** Re-throw anything that is not our own sentinel, unchanged. */
function failureOrRethrow(err: unknown): ToolFailure {
  if (err instanceof ToolFailureSignal) return err.failure;
  throw err;
}

/**
 * Wrap a function whose body uses {@link orFail}, so a failure it hits becomes
 * the function's return value.
 *
 * Works on a sync body and an async one, and answers in kind: a sync body gives
 * `R | ToolFailure`, an async one `Promise<R | ToolFailure>`. A body that
 * already returns a `ToolFailure` on some path is unaffected — the union simply
 * absorbs it.
 *
 * @example Two lookups in front of the work
 * ```ts
 * import { failable, orFail, type ToolFailure } from "@alexkroman1/aai";
 *
 * type Board = { incidents: Record<string, Incident> };
 * type Incident = { id: string; timeline: string[]; resolved: boolean };
 *
 * declare function findIncident(board: Board, id: string): Incident | ToolFailure;
 * declare function assertNotResolved(incident: Incident): ToolFailure | null;
 *
 * const addNote = failable((board: Board, id: string, note: string) => {
 *   const incident = orFail(findIncident(board, id));
 *   orFail(assertNotResolved(incident));
 *   incident.timeline.push(note);
 *   return { added: note, entries: incident.timeline.length };
 * });
 * ```
 *
 * @public
 */
export function failable<A extends readonly unknown[], R>(
  fn: (...args: A) => Promise<R>,
): (...args: A) => Promise<R | ToolFailure>;
export function failable<A extends readonly unknown[], R>(
  fn: (...args: A) => R,
): (...args: A) => R | ToolFailure;
export function failable<A extends readonly unknown[], R>(
  fn: (...args: A) => R | Promise<R>,
): (...args: A) => R | ToolFailure | Promise<R | ToolFailure> {
  return (...args: A) => {
    try {
      const out = fn(...args);
      // A thenable is awaited by the CALLER, so the sync `catch` below can
      // never see its rejection — the handler has to be attached here. Checked
      // structurally rather than with `instanceof Promise`: an async function
      // in a bundle with its own Promise realm is still thenable.
      if (typeof (out as { then?: unknown } | null | undefined)?.then === "function") {
        return Promise.resolve(out).catch(failureOrRethrow);
      }
      return out;
    } catch (err) {
      return failureOrRethrow(err);
    }
  };
}
