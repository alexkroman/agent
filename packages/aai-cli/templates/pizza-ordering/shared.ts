import type { ToolResultMap } from "@alexkroman1/aai";

export interface Pizza {
  id: number;
  size: "small" | "medium" | "large";
  crust: "thin" | "regular" | "thick" | "stuffed";
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
  return pizzas.reduce((total, pizza) => {
    const base = MENU.sizes[pizza.size];
    const crust = MENU.crusts[pizza.crust];
    const toppingsPrice = pizza.toppings.reduce(
      (sum, t) =>
        sum + (MENU.toppings[t as keyof typeof MENU.toppings] ?? 1.0),
      0,
    );
    return total + (base + crust + toppingsPrice) * pizza.quantity;
  }, 0);
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

/** Tool result types for this agent, keyed by tool name. */
export type PizzaToolResults = ToolResultMap<{
  add_pizza: { added: Pizza; orderTotal: string; itemCount: number };
  remove_pizza: { removed: Pizza; orderTotal: string; itemCount: number };
  update_pizza: { updated: Pizza; orderTotal: string };
  view_order: { pizzas: Pizza[]; orderTotal: string } | { message: string };
  set_customer_name: { name: string };
  place_order: {
    orderNumber: number;
    customerName: string;
    pizzas: number;
    total: string;
    estimatedMinutes: number;
  };
}>;
