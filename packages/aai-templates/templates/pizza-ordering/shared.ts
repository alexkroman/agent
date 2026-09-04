import { type DeepReadonly, sessionSlot } from "@alexkroman1/aai";
import { formatMoney } from "@alexkroman1/aai/utils";

export const SIZES = ["small", "medium", "large"] as const;
export const CRUSTS = ["thin", "regular", "thick", "stuffed"] as const;

export interface Pizza {
  id: number;
  size: (typeof SIZES)[number];
  crust: (typeof CRUSTS)[number];
  toppings: string[];
  quantity: number;
}

export const MENU = {
  sizes: { small: 8.99, medium: 11.99, large: 14.99 },
  crusts: { thin: 0, regular: 0, thick: 1.0, stuffed: 2.0 },
  toppings: {
    pepperoni: 1.5,
    sausage: 1.5,
    mushrooms: 1.0,
    onions: 1.0,
    green_peppers: 1.0,
    black_olives: 1.0,
    bacon: 2.0,
    ham: 1.5,
    pineapple: 1.0,
    jalapenos: 1.0,
    extra_cheese: 1.5,
    spinach: 1.0,
    tomatoes: 1.0,
    anchovies: 1.5,
    chicken: 2.0,
  },
} as const;

export function calculateTotal(pizzas: readonly ReadonlyPizza[]): number {
  return pizzas.reduce((total, pizza) => total + pizzaPrice(pizza), 0);
}

/**
 * The menu as prompt prose, generated from `MENU` so the agent can never
 * quote a price the pricing code doesn't charge.
 */
export function menuText(): string {
  const price = (amount: number, upcharge = false) =>
    amount === 0 ? "free" : `${upcharge ? "+" : ""}${formatMoney(amount)}`;
  const list = (items: Record<string, number>, upcharge = false) =>
    Object.entries(items)
      .map(([name, amount]) => `${name.replaceAll("_", " ")} (${price(amount, upcharge)})`)
      .join(", ");
  return [
    "Menu info:",
    `- Sizes: ${list(MENU.sizes)}`,
    `- Crusts: ${list(MENU.crusts, true)}`,
    `- Toppings: ${list(MENU.toppings)}`,
  ].join("\n");
}

/**
 * A topping name as the price table keys it.
 *
 * `menuText()` renders `extra_cheese` as "extra cheese", so the menu the model
 * reads and the table that charges for it are spelled differently — and the raw
 * lookup below then missed and charged the $1.00 unknown-topping default for a
 * $1.50 topping. `agent.eval.test.ts` found it against a live model: a large
 * pepperoni with extra cheese was quoted at the menu's $17.99 and rung up at
 * $17.49. Normalizing here keeps ONE spelling authoritative for pricing while
 * the cart still stores what the caller actually said, which is what the
 * sidebar and the read-back description show.
 */
export function toppingKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replaceAll(/[\s-]+/g, "_");
}

export function pizzaPrice(p: ReadonlyPizza): number {
  const base = MENU.sizes[p.size];
  const crust = MENU.crusts[p.crust];
  const toppings = p.toppings.reduce(
    (sum, t) => sum + (MENU.toppings[toppingKey(t) as keyof typeof MENU.toppings] ?? 1.0),
    0,
  );
  return (base + crust + toppings) * p.quantity;
}

// ── Order state ──────────────────────────────────────────────────────────────
// The in-progress order is session-scoped scratch, so it lives in one
// `sessionSlot` keyed per session — concurrent customers each get their own
// cart.

export interface OrderState {
  pizzas: Pizza[];
  nextId: number;
  customerName: string | null;
  /**
   * The confirmation, once checkout happens. In state rather than only in
   * `place_order`'s return value because the UI has to keep showing it after
   * the cart is cleared — and `syncState` can only project what state holds.
   */
  placed?: { orderNumber: number; total: string; estimatedMinutes: number };
}

export function emptyOrder(): OrderState {
  return { pizzas: [], nextId: 1, customerName: null };
}

/** The session's cart, as one typed slot. */
export const orderSlot = sessionSlot("order", emptyOrder);

/**
 * A pizza as a READ hands it out, and the cart likewise: deep-frozen, and typed
 * to say so.
 *
 * `pizzaPrice` and `calculateTotal` take the readonly shape because they are
 * pure and are called from both halves of the slot — a mutable `Pizza` still
 * satisfies it, so an `updateTool` draft passes unchanged, while a helper that
 * WOULD have mutated stops compiling instead of throwing on its first call.
 */
export type ReadonlyPizza = DeepReadonly<Pizza>;
export type FrozenOrderState = DeepReadonly<OrderState>;

/**
 * Clear the cart after checkout so a follow-up order starts fresh. The
 * `placed` confirmation is passed through, because the UI is still showing
 * it — clearing the pizzas is what "reset" means here, not forgetting the
 * order that was just submitted.
 *
 * It takes the DRAFT, not the context, and that is the shape to copy. It used to
 * call `orderSlot.set(ctx, …)` — which is a second write to the same slot from
 * inside a mutating tool body, so the draft stored on the way out overwrote it
 * and the cart was never cleared. `slot.set` refuses that outright now; a helper
 * called from inside a mutation mutates what it was handed.
 */
export function resetOrder(order: OrderState, placed?: OrderState["placed"]): void {
  const fresh = emptyOrder();
  order.pizzas = fresh.pizzas;
  order.nextId = fresh.nextId;
  order.customerName = fresh.customerName;
  if (placed) order.placed = placed;
  else delete order.placed;
}

/**
 * What the browser sees. A projection rather than the raw state: the client
 * needs the cart and its total, and `syncState` is where you decide what
 * leaves the server.
 */
export interface OrderView {
  /** Readonly, because the projection hands the client the slot's own list
   *  rather than a copy — see {@link ReadonlyPizza}. */
  pizzas: readonly ReadonlyPizza[];
  total: string;
  orderPlaced: boolean;
  orderNumber?: number;
  estimatedMinutes?: number;
}

/** Takes the cart itself, not the slot — `orderSlot.projection` supplies a real
 *  one even before the first tool call, so there is nothing to optional-chain. */
export function orderView(order: FrozenOrderState): OrderView {
  const placed = order.placed;
  return {
    pizzas: order.pizzas,
    total: placed?.total ?? formatMoney(calculateTotal(order.pizzas)),
    orderPlaced: Boolean(placed),
    ...(placed
      ? { orderNumber: placed.orderNumber, estimatedMinutes: placed.estimatedMinutes }
      : {}),
  };
}

/** The projection BOTH ends use: `syncState` on the agent, `useAgentState` in the client. */
export const orderProjection = orderSlot.projection(orderView);
