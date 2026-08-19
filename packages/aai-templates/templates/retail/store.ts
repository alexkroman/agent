import type { ToolContext, ToolFailure } from "@alexkroman1/aai";
import { isToolFailure, pushCapped, sessionSlot, toolFailure } from "@alexkroman1/aai";
import type { z } from "zod";
import seedJson from "./seed.json";
import type {
  GiftCard,
  Order,
  PaymentMethod,
  Product,
  RetailState,
  Store,
  User,
  Variant,
} from "./shared.ts";
import { emptyRetailState, MAX_ACTIVITY } from "./shared.ts";

/**
 * The JSON import's inferred type has `status: string` where `Order` wants a
 * union, so a direct assignment can't type-check. The cast is validated once,
 * for real, by `seed.test.ts` — which parses this same file through a zod
 * schema — rather than by paying a 107 KB validation on every session start.
 */
const SEED = seedJson as unknown as Store;

/** Round to cents. Gift-card balances and price differences are compared for
 *  equality, and raw float arithmetic makes that a coin toss. */
export function money(n: number): number {
  return Math.round(n * 100) / 100;
}

export function isGiftCard(method: PaymentMethod): method is GiftCard {
  return method.source === "gift_card";
}

// ─── Session state ───────────────────────────────────────────────────────────

/** A pristine store per session. The deep clone is load-bearing: `SEED` is one
 *  module-level object shared by every session in the process, so a mutation
 *  without it would let one caller's cancellation show up in another's. */
export function createDefaultState(): RetailState {
  return { ...emptyRetailState(), store: seedStore() };
}

/**
 * A pristine deep copy of the seed store.
 *
 * Exported so a caller needs no cast of its own. `shared.test.ts` had written
 * `structuredClone(seedJson) as unknown as Store` twice — a second and third
 * copy of the narrowing this module already owns, each of which would keep
 * compiling if `Store` grew a field the JSON does not carry. The one cast is
 * `SEED`'s above, and `seed.test.ts` is what makes it honest.
 */
export function seedStore(): Store {
  return structuredClone(SEED);
}

/**
 * The session's store, as one typed slot.
 *
 * Every tool goes through `retailSlot.updateTool` (via `retailTool`), so every
 * tool body is handed a mutable draft of the whole store and mutates it in
 * place: the ~106 KB of catalogue here is exactly the state a functional replace
 * would make unwritable without hand-built spread chains three levels deep.
 * What makes that safe is that the window is SYNCHRONOUS — the LLM loop runs a
 * step's tool calls concurrently, and a draft that cannot span an await cannot
 * interleave with another one.
 *
 * No `after` hook — unlike dispatch-center, this store has no derived field to
 * recalculate, and its one growth cap (`activity`) is held on append by
 * `record` below.
 */
export const retailSlot = sessionSlot("retail", createDefaultState);

export function setFocus(
  state: RetailState,
  focus: { orderId?: string; productId?: string },
): void {
  state.focus = { ...state.focus, ...focus };
}

// ─── Lookups ─────────────────────────────────────────────────────────────────

export function findUser(state: RetailState, userId: string): User | ToolFailure {
  return state.store.users[userId] ?? { error: `User ${userId} not found.` };
}

export function findOrder(state: RetailState, orderId: string): Order | ToolFailure {
  return state.store.orders[orderId] ?? { error: `Order ${orderId} not found.` };
}

export function findProduct(state: RetailState, productId: string): Product | ToolFailure {
  return (
    state.store.products[productId] ?? {
      error: `Product ${productId} not found. Note a product id is not an item id.`,
    }
  );
}

export function findVariant(product: Product, itemId: string): Variant | ToolFailure {
  return (
    product.variants[itemId] ?? {
      error: `Item ${itemId} is not a variant of ${product.name} (${product.product_id}).`,
    }
  );
}

/** Item ids carry no product reference, so finding one means scanning. */
export function findItem(
  state: RetailState,
  itemId: string,
): { product: Product; variant: Variant } | ToolFailure {
  for (const product of Object.values(state.store.products)) {
    const variant = product.variants[itemId];
    if (variant) return { product, variant };
  }
  return { error: `Item ${itemId} not found. Note an item id is not a product id.` };
}

export function findPaymentMethod(user: User, methodId: string): PaymentMethod | ToolFailure {
  return (
    user.payment_methods[methodId] ?? {
      error: `Payment method ${methodId} is not on this customer's profile. Available: ${Object.keys(
        user.payment_methods,
      ).join(", ")}.`,
    }
  );
}

// ─── Guards ──────────────────────────────────────────────────────────────────

const NOT_AUTHENTICATED =
  "Not authenticated. Identify the customer first with find_user_id_by_email, " +
  "or find_user_id_by_name_zip if they cannot remember their email.";

export function authenticatedUser(state: RetailState): User | ToolFailure {
  if (!state.authenticatedUserId) return { error: NOT_AUTHENTICATED };
  return findUser(state, state.authenticatedUserId);
}

/**
 * Resolve an order that belongs to the authenticated customer.
 *
 * An order belonging to someone else and an order that does not exist share
 * one template on purpose: no "belongs to another customer" vs. "does not
 * exist" wording, no owner name, no product name — nothing that lets a
 * caller learn something they did not already know. The echoed `orderId` is
 * the caller's own input, not information about the store, so keeping it
 * matches every sibling lookup (`findUser`, `findOrder`, `findProduct`, …),
 * which all echo the id precisely so an LLM can target a repair retry.
 */
export function requireOwnOrder(state: RetailState, orderId: string): Order | ToolFailure {
  const user = authenticatedUser(state);
  if (isToolFailure(user)) return user;
  const order = state.store.orders[orderId];
  if (!order || order.user_id !== user.user_id) {
    return { error: `Order ${orderId} was not found on this customer's account.` };
  }
  return order;
}

/**
 * The authenticated customer, when `userId` names them.
 *
 * The wrapper's auth gate says a customer is on the call; a tool whose schema
 * takes a `user_id` also needs to know the caller named THAT customer, and only
 * one message is right for the second. Two tools had the pair of guards written
 * out, so the message was maintained in two places — the same reason
 * {@link requireOwnOrder} exists one rule up.
 */
export function requireOwnUser(state: RetailState, userId: string): User | ToolFailure {
  const user = authenticatedUser(state);
  if (isToolFailure(user)) return user;
  if (user.user_id !== userId) {
    return {
      error: `${userId} is not the customer on this call. You can help only one customer per conversation.`,
    };
  }
  return user;
}

// ─── The tool wrapper ────────────────────────────────────────────────────────

interface RetailToolSpec<S extends z.ZodType<Record<string, unknown>>, R> {
  /** Must equal this tool's key in `agent.ts`. `agent.test.ts` asserts it. */
  name: string;
  description: string;
  /** Required even for no-arg tools — pass `z.object({})`. One code path in the
   *  wrapper is worth more than saving a line at one call site. */
  inputSchema: S;
  /** Default true. Only the two finder tools and the three catalog tools opt
   *  out; everything else touches customer data. */
  requiresAuth?: boolean;
  summary: (args: z.output<S>, result: R) => string;
  /**
   * Handed the store as its second argument, and SYNCHRONOUS.
   *
   * **Declare it BEFORE `summary` in the object literal.** TS infers this
   * wrapper's generic `R` from `execute`'s return type and processes an object
   * literal's properties in SOURCE ORDER, so with `summary` written first its
   * `result` parameter has nothing to infer from and silently falls back to
   * `unknown` — every `isToolFailure(result) ? … : result.order_id` in the
   * fifteen tool files then stops compiling, or worse, stops meaning anything.
   * It lives here rather than in each tool file because it is a property of
   * this type: the same four lines were pasted into eight of the fifteen and
   * pointed at from five more, which is a rule maintained in fourteen places.
   *
   * ---
   *
   * **The draft is passed in rather than re-read**, which is the one change the
   * durable store forced on this template. The body used to open with
   * `retailSlot.get(ctx)`; under the draft write model that returns the value as
   * it was BEFORE this call, frozen, so a body that mutated it would be writing
   * to something nothing was going to store. Passing it removes the possibility
   * rather than documenting it.
   *
   * Synchronous for the same reason: the window cannot span an await — see
   * {@link SessionSlot.update}. Every tool here is a pure function of the store,
   * so none of them wants to; a tool that DID would await outside the wrapper and
   * call `retailSlot.update` itself, the way `plan-and-execute`'s do.
   */
  execute: (args: z.output<S>, state: RetailState, ctx: ToolContext) => R;
}

function record(state: RetailState, name: string, summary: string): void {
  state.callSeq += 1;
  pushCapped(
    state.activity,
    { seq: state.callSeq, tool: name, summary, at: Date.now() },
    MAX_ACTIVITY,
  );
}

/**
 * Every retail tool is built through this. It owns three things no tool body
 * may re-implement:
 *
 * 1. the authentication gate,
 * 2. serialization of the state mutation,
 * 3. the `callSeq` increment + activity entry — the reason the UI moves on
 *    EVERY tool call rather than only when a projected value happens to differ.
 *
 * `focus` is deliberately left to tool bodies (`setFocus`): it is a UI nicety,
 * not an invariant, and only the body knows what the call was about.
 */
export function retailTool<S extends z.ZodType<Record<string, unknown>>, R>(
  spec: RetailToolSpec<S, R>,
) {
  const requiresAuth = spec.requiresAuth ?? true;
  // `updateTool` rather than `tool` + a hand-written `retailSlot.update`: it runs
  // the body inside the slot's mutation window and hands it the draft, so this
  // wrapper is left with only what is specific to THIS agent.
  return retailSlot.updateTool({
    description: spec.description,
    inputSchema: spec.inputSchema,
    execute: (args, state, ctx) => {
      const typedArgs = args as z.output<S>;
      if (requiresAuth && !state.authenticatedUserId) {
        record(state, spec.name, "blocked: not authenticated");
        return toolFailure(NOT_AUTHENTICATED);
      }
      const result = spec.execute(typedArgs, state, ctx);
      record(
        state,
        spec.name,
        isToolFailure(result) ? `error: ${result.error}` : spec.summary(typedArgs, result),
      );
      return result;
    },
  });
}
