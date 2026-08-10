import type { ToolContext } from "@alexkroman1/aai";
import { createKeyedLock, tool, withLock } from "@alexkroman1/aai";
import type { z } from "zod";
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
import { MAX_ACTIVITY } from "./shared.ts";

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

// ─── Serialized state updates ────────────────────────────────────────────────

const sessionLock = createKeyedLock();

/**
 * Serialized update of the session's store.
 *
 * The LLM loop can execute parallel tool calls, and a mutator may be async —
 * two interleaving async mutators can each observe the other's half-applied
 * changes. Holding the session's key runs each update against the previous
 * one's finished result. `createKeyedLock` is the SDK's primitive for exactly
 * this; the hand-rolled promise chain it replaced also had to remember to drop
 * each key's entry by ownership once idle.
 *
 * NOT exported, unlike dispatch-center's equivalent. `retailTool` is the only
 * caller, so a tool body cannot re-enter it — which would wait on a key only
 * the outer call can release, i.e. deadlock. A hazard you can't reach beats a
 * hazard you documented.
 */
function updateState<R>(
  ctx: ToolContext,
  mutator: (state: RetailState) => R | Promise<R>,
): Promise<R> {
  return withLock(sessionLock, ctx.sessionId, async () => mutator(getState(ctx)));
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
  execute: (args: z.output<S>, ctx: ToolContext) => R | Promise<R>;
}

function record(state: RetailState, name: string, summary: string): void {
  state.callSeq += 1;
  state.activity.push({ seq: state.callSeq, tool: name, summary, at: Date.now() });
  if (state.activity.length > MAX_ACTIVITY) {
    state.activity = state.activity.slice(-MAX_ACTIVITY);
  }
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
  return tool({
    description: spec.description,
    inputSchema: spec.inputSchema,
    execute: (args, ctx) =>
      updateState(ctx, async (state) => {
        const typedArgs = args as z.output<S>;
        if (requiresAuth && !state.authenticatedUserId) {
          record(state, spec.name, "blocked: not authenticated");
          return { error: NOT_AUTHENTICATED };
        }
        const result = await spec.execute(typedArgs, ctx);
        record(
          state,
          spec.name,
          isError(result) ? `error: ${result.error}` : spec.summary(typedArgs, result),
        );
        return result;
      }),
  });
}
