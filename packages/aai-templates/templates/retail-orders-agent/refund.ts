import type { User } from "./shared.ts";
import { isGiftCard, money } from "./store.ts";

/**
 * Credit a refund. A gift card is topped up in place and the money is back
 * immediately; every other method takes 5–7 business days, which is a statement
 * about the outside world and so changes no state here.
 */
export function creditRefund(user: User, methodId: string, amount: number): { immediate: boolean } {
  const method = user.payment_methods[methodId];
  if (method && isGiftCard(method)) {
    method.balance = money(method.balance + amount);
    return { immediate: true };
  }
  return { immediate: false };
}

export const REFUND_DELAY_NOTE = "The refund will appear in 5 to 7 business days.";
export const REFUND_IMMEDIATE_NOTE = "The refund is on the gift card immediately.";
