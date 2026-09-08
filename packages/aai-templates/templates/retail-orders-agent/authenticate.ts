import type { ToolFailure } from "@alexkroman1/aai";
import type { RetailState, User } from "./shared.ts";

export interface AuthResult {
  user_id: string;
  name: string;
  order_count: number;
}

/**
 * Latch the session onto one customer.
 *
 * Switching to a different customer is refused. tau2 keeps "you can only help
 * one user per conversation" in the prompt, which leaves the ownership guard on
 * every other tool trivially bypassable — just re-authenticate as whoever's
 * order you want. Re-running a finder for the SAME customer succeeds, because a
 * caller repeating their email should not hit an error.
 */
export function authenticateAs(state: RetailState, user: User): AuthResult | ToolFailure {
  const current = state.authenticatedUserId;
  if (current && current !== user.user_id) {
    return {
      error:
        "This conversation is already helping another customer, and you can help only " +
        "one customer per conversation. Ask the caller to start a new call.",
    };
  }
  state.authenticatedUserId = user.user_id;
  return {
    user_id: user.user_id,
    name: `${user.name.first_name} ${user.name.last_name}`,
    order_count: user.orders.length,
  };
}
