import { formatMoney } from "@alexkroman1/aai/utils";
import { calculateTotal, orderSlot } from "../shared.ts";

export default orderSlot.tool({
  description: "View the current order summary with all pizzas and total price.",
  execute(_args, order) {
    const pizzas = order.pizzas;
    if (pizzas.length === 0) return { message: "The order is empty." };

    return {
      pizzas: pizzas.map((p) => ({
        id: p.id,
        description: `${p.quantity}x ${p.size} ${p.crust} crust with ${p.toppings.length > 0 ? p.toppings.join(", ") : "cheese only"}`,
        size: p.size,
        crust: p.crust,
        toppings: p.toppings,
        quantity: p.quantity,
      })),
      orderTotal: formatMoney(calculateTotal(pizzas)),
    };
  },
});
