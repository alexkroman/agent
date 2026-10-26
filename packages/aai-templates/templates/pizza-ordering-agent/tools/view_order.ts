import { withInstruction } from "@alexkroman1/aai/utils";
import { cartSummary, orderSlot } from "../shared.ts";

export default orderSlot.tool({
  description: "View the current order summary with all pizzas and total price.",
  execute(_args, order) {
    const pizzas = order.pizzas;
    const summary = {
      pizzas: pizzas.map((p) => ({
        id: p.id,
        description: `${p.quantity}x ${p.size} ${p.crust} crust with ${p.toppings.length > 0 ? p.toppings.join(", ") : "cheese only"}`,
        size: p.size,
        crust: p.crust,
        toppings: p.toppings,
        quantity: p.quantity,
      })),
      ...cartSummary(pizzas),
    };
    // One shape either way; what changes on an empty cart is what the model
    // should DO about it, which is an instruction rather than a field.
    return pizzas.length === 0
      ? withInstruction(summary, "The order is empty. Ask what they would like.")
      : summary;
  },
});
