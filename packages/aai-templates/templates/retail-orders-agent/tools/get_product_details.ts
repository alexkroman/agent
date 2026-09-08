import { isToolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { BEFORE_TRANSFER, findProduct, retailTool, setFocus } from "../store.ts";

export default retailTool({
  name: "get_product_details",
  description:
    "Get a product's variants — each with its item id, options, price and availability. Takes a " +
    "PRODUCT id, which is not the same as an item id. Use list_all_product_types to find one.",
  inputSchema: z.object({
    product_id: z.string().max(60).describe("The product id, e.g. '6086499569'"),
  }),
  when: BEFORE_TRANSFER,
  execute: (args, state) => {
    const product = findProduct(state, args.product_id);
    if (isToolFailure(product)) return product;
    setFocus(state, { productId: product.product_id });
    return {
      name: product.name,
      product_id: product.product_id,
      variants: Object.values(product.variants).map((variant) => ({
        item_id: variant.item_id,
        options: variant.options,
        price: variant.price,
        available: variant.available,
      })),
    };
  },
  summary: (_args, result) => `read product ${result.name}`,
});
