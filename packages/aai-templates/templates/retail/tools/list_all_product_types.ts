import { z } from "zod";
import { retailSlot, retailTool } from "../store.ts";

export const listAllProductTypes = retailTool({
  name: "list_all_product_types",
  description:
    "List every product type the store carries, as a name-to-product-id map. Each product type " +
    "has variant items with their own item ids and options.",
  // Empty schema rather than omitting it: the wrapper has one code path, and
  // that is where the per-call UI-update invariant lives.
  input: z.object({}),
  requiresAuth: false,
  // `run` before `summary`: see find_user_id_by_email.ts for why the order
  // is load-bearing for the generic `result` type in `summary`.
  run: (_args, ctx) => {
    const state = retailSlot.get(ctx);
    const entries = Object.values(state.store.products)
      .map((product) => [product.name, product.product_id] as const)
      .sort(([a], [b]) => a.localeCompare(b));
    return { count: entries.length, products: Object.fromEntries(entries) };
  },
  summary: (_args, result) =>
    "error" in result ? "catalog read failed" : `listed ${result.count} product types`,
});
