import { isToolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { BEFORE_TRANSFER, retailTool } from "../store.ts";

export default retailTool({
  name: "list_all_product_types",
  description:
    "List every product type the store carries, as a name-to-product-id map. Each product type " +
    "has variant items with their own item ids and options.",
  // Empty schema rather than omitting it: the wrapper has one code path, and
  // that is where the per-call UI-update invariant lives.
  inputSchema: z.object({}),
  // The catalogue is not customer data, so it needs no identified caller — but
  // it is still off limits once the call belongs to a human.
  when: BEFORE_TRANSFER,
  execute: (_args, state) => {
    const entries = Object.values(state.store.products)
      .map((product) => [product.name, product.product_id] as const)
      .sort(([a], [b]) => a.localeCompare(b));
    return { count: entries.length, products: Object.fromEntries(entries) };
  },
  summary: (_args, result) =>
    isToolFailure(result) ? "catalog read failed" : `listed ${result.count} product types`,
});
