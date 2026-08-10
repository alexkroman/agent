import { isToolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { authenticatedUser, retailSlot, retailTool } from "../store.ts";

export const getUserDetails = retailTool({
  name: "get_user_details",
  description:
    "Get the authenticated customer's profile: name, email, default address, payment methods " +
    "(with gift-card balances) and their order ids with each order's status.",
  inputSchema: z.object({
    user_id: z.string().max(100).describe("The user id, e.g. 'sara_doe_496'"),
  }),
  // `execute` before `summary`: see find_user_id_by_email.ts for why the order
  // is load-bearing for the generic `result` type in `summary`.
  execute: (args, ctx) => {
    const state = retailSlot.get(ctx);
    const user = authenticatedUser(state);
    if (isToolFailure(user)) return user;
    if (user.user_id !== args.user_id) {
      return {
        error: `${args.user_id} is not the customer on this call. You can help only one customer per conversation.`,
      };
    }
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
    "error" in result ? "profile read failed" : `read profile ${result.user_id}`,
});
