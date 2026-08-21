import { isToolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { requireOwnUser, retailTool } from "../store.ts";

export default retailTool({
  name: "get_user_details",
  when: "serving",
  description:
    "Get the authenticated customer's profile: name, email, default address, payment methods " +
    "(with gift-card balances) and their order ids with each order's status.",
  inputSchema: z.object({
    user_id: z.string().max(100).describe("The user id, e.g. 'sara_doe_496'"),
  }),
  execute: (args, state) => {
    const user = requireOwnUser(state, args.user_id);
    if (isToolFailure(user)) return user;
    return {
      user_id: user.user_id,
      name: `${user.name.first_name} ${user.name.last_name}`,
      email: user.email,
      address: user.address,
      payment_methods: Object.values(user.payment_methods).map((method) => ({
        payment_method_id: method.id,
        source: method.source,
        ...(method.source === "gift_card" ? { balance: method.balance } : {}),
        ...(method.source === "credit_card"
          ? { brand: method.brand, last_four: method.last_four }
          : {}),
      })),
      orders: user.orders.map((id) => ({
        order_id: id,
        status: state.store.orders[id]?.status ?? "unknown",
      })),
    };
  },
  summary: (_args, result) =>
    isToolFailure(result) ? "profile read failed" : `read profile ${result.user_id}`,
});
