import type { ToolContext } from "@alexkroman1/aai";
import seedJson from "./seed.json";
import type {
  GiftCard,
  Order,
  PaymentMethod,
  Product,
  RetailState,
  StateSlot,
  Store,
  User,
  Variant,
} from "./shared.ts";

/**
 * The JSON import's inferred type has `status: string` where `Order` wants a
 * union, so a direct assignment can't type-check. The cast is validated once,
 * for real, by `seed.test.ts` — which parses this same file through a zod
 * schema — rather than by paying a 107 KB validation on every session start.
 */
const SEED = seedJson as unknown as Store;

export type ErrorResult = { error: string };

export function isError(value: unknown): value is ErrorResult {
  return typeof value === "object" && value !== null && "error" in value;
}

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
  return {
    store: structuredClone(SEED),
    authenticatedUserId: null,
    callSeq: 0,
    activity: [],
    focus: {},
  };
}

/** The session's live store. Mutations to the returned object stick — it is
 *  the object held in `ctx.state`. */
export function getState(ctx: ToolContext): RetailState {
  const slot = ctx.state as StateSlot;
  slot.retail ??= createDefaultState();
  return slot.retail;
}

export function setFocus(
  state: RetailState,
  focus: { orderId?: string; productId?: string },
): void {
  state.focus = { ...state.focus, ...focus };
}

// ─── Lookups ─────────────────────────────────────────────────────────────────

export function findUser(state: RetailState, userId: string): User | ErrorResult {
  return state.store.users[userId] ?? { error: `User ${userId} not found.` };
}

export function findOrder(state: RetailState, orderId: string): Order | ErrorResult {
  return state.store.orders[orderId] ?? { error: `Order ${orderId} not found.` };
}

export function findProduct(state: RetailState, productId: string): Product | ErrorResult {
  return (
    state.store.products[productId] ?? {
      error: `Product ${productId} not found. Note a product id is not an item id.`,
    }
  );
}

export function findVariant(product: Product, itemId: string): Variant | ErrorResult {
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
): { product: Product; variant: Variant } | ErrorResult {
  for (const product of Object.values(state.store.products)) {
    const variant = product.variants[itemId];
    if (variant) return { product, variant };
  }
  return { error: `Item ${itemId} not found. Note an item id is not a product id.` };
}

export function findPaymentMethod(user: User, methodId: string): PaymentMethod | ErrorResult {
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

export function authenticatedUser(state: RetailState): User | ErrorResult {
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
export function requireOwnOrder(state: RetailState, orderId: string): Order | ErrorResult {
  const user = authenticatedUser(state);
  if (isError(user)) return user;
  const order = state.store.orders[orderId];
  if (!order || order.user_id !== user.user_id) {
    return { error: `Order ${orderId} was not found on this customer's account.` };
  }
  return order;
}
