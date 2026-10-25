import { BEFORE_TRANSFER, callFlow, retailSlot } from "../store.ts";

export default retailSlot.updateTool({
  dialog: callFlow,
  description:
    "List every product type the store carries, as a name-to-product-id map. Each product type " +
    "has variant items with their own item ids and options.",
  // The catalogue is not customer data, so it needs no identified caller — but
  // it is still off limits once the call belongs to a human.
  when: BEFORE_TRANSFER,
  execute: (_args, state) => {
    const entries = Object.values(state.store.products)
      .map((product) => [product.name, product.product_id] as const)
      .sort(([a], [b]) => a.localeCompare(b));
    return { count: entries.length, products: Object.fromEntries(entries) };
  },
});
