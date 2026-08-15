import { isToolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { findItem, retailTool } from "../store.ts";

export default retailTool({
  name: "get_item_details",
  description:
    "Get one specific item's options, price and availability. Takes an ITEM id, which is not the " +
    "same as a product id.",
  inputSchema: z.object({
    item_id: z.string().max(60).describe("The item id, e.g. '1008292230'"),
  }),
  requiresAuth: false,
  execute: (args, state) => {
    const found = findItem(state, args.item_id);
    if (isToolFailure(found)) return found;
    return {
      item_id: found.variant.item_id,
      product_id: found.product.product_id,
      product_name: found.product.name,
      options: found.variant.options,
      price: found.variant.price,
      available: found.variant.available,
    };
  },
  summary: (_args, result) =>
    isToolFailure(result) ? "item read failed" : `read item ${result.item_id}`,
});
