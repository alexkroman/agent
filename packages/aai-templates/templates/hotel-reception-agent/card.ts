/**
 * Card validation — their `GetCardTask`'s four `ToolError`s, as one pure check
 * shared by `record_card` (a new booking) and `update_card` (a replacement).
 *
 * The number is validated and the last four kept; nothing else about it is
 * returned, so no caller of this function can store what it should not.
 */

import type { ToolFailure } from "@alexkroman1/aai";
import { toolFailure } from "@alexkroman1/aai";
import { digitsOf, TODAY } from "./records.ts";

const ISSUERS: Record<string, string> = {
  "3": "American Express",
  "4": "Visa",
  "5": "Mastercard",
  "6": "Discover",
};

export interface CardInput {
  cardNumber: string;
  expiryMonth: number;
  expiryYear: number;
  securityCode: string;
  cardholderName: string;
}

export interface ValidCard {
  last4: string;
  issuer: string;
  expiry: string;
  cardholder: string;
}

/** The Luhn check every card number passes and a misheard digit fails. */
export function luhnOk(digits: string): boolean {
  let total = 0;
  for (let i = 0; i < digits.length; i++) {
    let n = Number(digits.at(-1 - i));
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    total += n;
  }
  return total % 10 === 0;
}

/**
 * The card, or the ONE field to re-ask for.
 *
 * A {@link ToolFailure} rather than the `{ error: string }` this used to
 * declare — the same object, named by the SDK, so `record_card` and
 * `update_card` forward it with `isToolFailure` instead of unpacking the
 * sentence and building a second failure out of it.
 */
export function validateCard(input: CardInput): ValidCard | ToolFailure {
  const digits = digitsOf(input.cardNumber);
  if (digits.length < 13 || digits.length > 19) {
    return toolFailure(
      "that card number has the wrong number of digits - ask the caller to read it again",
    );
  }
  if (!luhnOk(digits)) {
    return toolFailure(
      "that number fails the card check, one digit is likely off - ask the caller to read it again slowly",
    );
  }
  const month = input.expiryMonth;
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    return toolFailure("that expiration month is invalid - ask the caller to repeat it");
  }
  const year = input.expiryYear < 100 ? 2000 + input.expiryYear : input.expiryYear;
  const [todayYear, todayMonth] = TODAY.split("-").map(Number) as [number, number];
  if (year < todayYear || (year === todayYear && month < todayMonth)) {
    return toolFailure("that date is in the past, the card is expired - ask for another card");
  }
  const code = input.securityCode.trim();
  if (!/^\d{3,4}$/.test(code)) {
    return toolFailure("the security code should be 3 or 4 digits - ask the caller to repeat it");
  }
  const cardholder = input.cardholderName.trim();
  if (!/[a-z]/i.test(cardholder)) {
    return toolFailure(`"${input.cardholderName}" doesn't look like a name - ask again`);
  }
  return {
    last4: digits.slice(-4),
    issuer: ISSUERS[digits[0] ?? ""] ?? "Other",
    expiry: `${String(month).padStart(2, "0")}/${String(year % 100).padStart(2, "0")}`,
    cardholder,
  };
}
