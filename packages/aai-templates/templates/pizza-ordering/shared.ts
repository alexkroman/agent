import type { ToolContext } from "@alexkroman1/aai";

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

export function calculateTotal(pizzas: Pizza[]): number {
  return pizzas.reduce((total, pizza) => total + pizzaPrice(pizza), 0);
}

export function pizzaPrice(p: Pizza): number {
  const base = MENU.sizes[p.size];
  const crust = MENU.crusts[p.crust];
  const toppings = p.toppings.reduce(
    (sum, t) => sum + (MENU.toppings[t as keyof typeof MENU.toppings] ?? 1.0),
    0,
  );
  return (base + crust + toppings) * p.quantity;
}

// ── Order state ──────────────────────────────────────────────────────────────
// The in-progress order is session-scoped scratch, so it lives in `ctx.state`
// (the agent's per-session mutable state) — concurrent customers each get
// their own cart, and an abandoned cart vanishes with its session.

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

export type StateSlot = { order?: OrderState };

function emptyOrder(): OrderState {
  return { pizzas: [], nextId: 1, customerName: null };
}

/** The session's live cart. Mutations to the returned object stick — it is
 *  the object stored in `ctx.state`. */
export function getOrder(ctx: ToolContext): OrderState {
  const slot = ctx.state as StateSlot;
  slot.order ??= emptyOrder();
  return slot.order;
}

/**
 * Clear the cart after checkout so a follow-up order starts fresh. The
 * `placed` confirmation is passed through, because the UI is still showing
 * it — clearing the pizzas is what "reset" means here, not forgetting the
 * order that was just submitted.
 */
export function resetOrder(ctx: ToolContext, placed?: OrderState["placed"]): void {
  const slot = ctx.state as StateSlot;
  slot.order = { ...emptyOrder(), ...(placed ? { placed } : {}) };
}

/**
 * What the browser sees. A projection rather than the raw slot: the client
 * needs the cart and its total, and `syncState` is where you decide what
 * leaves the server.
 */
export interface OrderView {
  pizzas: Pizza[];
  total: string;
  orderPlaced: boolean;
  orderNumber?: number;
  estimatedMinutes?: number;
}

export function orderView(state: StateSlot): OrderView {
  const order = state.order;
  const pizzas = order?.pizzas ?? [];
  const placed = order?.placed;
  return {
    pizzas,
    total: placed?.total ?? `$${calculateTotal(pizzas).toFixed(2)}`,
    orderPlaced: Boolean(placed),
    ...(placed
      ? { orderNumber: placed.orderNumber, estimatedMinutes: placed.estimatedMinutes }
      : {}),
  };
}
