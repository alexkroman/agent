import { randomInt } from "@alexkroman1/aai";
import { toolFailure } from "@alexkroman1/aai/utils";
import { cartSummary, orderSlot, resetOrder } from "../shared.ts";

export default orderSlot.updateTool({
  annotations: { readOnlyHint: false },
  description:
    "Place the final order. Use when the customer confirms they are done and ready to order.",
  ui: { icon: "\u{2705}", label: "Placing order" },
  // The precondition, checked before the body — and before a draft is opened.
  require: (order) =>
    order.pizzas.length === 0 ? toolFailure("Cannot place an empty order.") : undefined,
  execute(_args, order, ctx) {
    const pizzas = order.pizzas;
    const customerName = order.customerName ?? "Guest";
    const { orderTotal: total } = cartSummary(pizzas);
    // Four digits, over `ctx.random` rather than the global — so a spec can
    // assert the number a confirmation carried. `agent.test.ts` does, by
    // handing `createToolContext` a `createSeededRandom` source.
    const orderNumber = 1000 + randomInt(9000, ctx.random);

    const estimatedMinutes = 15 + pizzas.length * 5;
    // The order is submitted — clear the cart so a follow-up order starts
    // fresh, but keep the confirmation in state so the UI can show it.
    resetOrder(order, { orderNumber, total, estimatedMinutes });

    return { orderNumber, customerName, pizzas: pizzas.length, total, estimatedMinutes };
  },
});
