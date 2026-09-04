import { toolFailure } from "@alexkroman1/aai";
import { formatMoney } from "@alexkroman1/aai/utils";
import { calculateTotal, orderSlot, resetOrder } from "../shared.ts";

export default orderSlot.updateTool({
  description:
    "Place the final order. Use when the customer confirms they are done and ready to order.",
  execute(_args, order) {
    const pizzas = order.pizzas;
    if (pizzas.length === 0) return toolFailure("Cannot place an empty order.");

    const customerName = order.customerName ?? "Guest";
    const total = formatMoney(calculateTotal(pizzas));
    const orderNumber = Math.floor(1000 + Math.random() * 9000);

    const estimatedMinutes = 15 + pizzas.length * 5;
    // The order is submitted — clear the cart so a follow-up order starts
    // fresh, but keep the confirmation in state so the UI can show it.
    resetOrder(order, { orderNumber, total, estimatedMinutes });

    return { orderNumber, customerName, pizzas: pizzas.length, total, estimatedMinutes };
  },
});
