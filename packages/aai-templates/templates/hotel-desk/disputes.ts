/**
 * Their dispute engine: `DISPUTE_POLICIES`, `_resolve_dispute_outcome` and
 * `_say_dispute_outcome`, ported line for line.
 *
 * The reason it is worth a module rather than a paragraph in a prompt is the
 * README's first sentence — the LLM never owns money. `dispute_charge` reads the
 * disputed amount OFF THE STORED LINE ITEM, and this table decides what may be
 * refunded from it; the model contributes the category and whether the caller
 * accepted what was offered, and nothing else. A prompt saying "small minibar
 * charges may be waived" leaves the threshold to the model's memory; this makes
 * `PRICING.minibarAutoRefundThreshold` the only number that matters.
 */

import {
  type DisputeCategory,
  type DisputeOutcome,
  type LineItem,
  PRICING,
  speakCode,
  speakUsd,
  usd,
} from "./records.ts";

export type DisputeAction =
  | "auto_refund_if_under_threshold"
  | "verify_explain_then_offer_credit"
  | "explain_no_refund"
  | "explain_policy_offer_goodwill"
  | "correct_immediately_or_open_ticket";

export interface DisputePolicy {
  action: DisputeAction;
  escalation: "manager" | "accounting" | "none";
  /** What the receptionist says about the policy, in the first person. */
  explanation: string;
}

export const DISPUTE_POLICIES: Record<DisputeCategory, DisputePolicy> = {
  minibar: {
    action: "auto_refund_if_under_threshold",
    escalation: "manager",
    explanation:
      "For small minibar charges I can waive them right away. " +
      "If it's a larger amount I'll verify against the housekeeping note first.",
  },
  room_service_restaurant: {
    action: "verify_explain_then_offer_credit",
    escalation: "manager",
    explanation:
      "I'll pull up the order. If something looks off I can apply a credit, " +
      "or escalate to the food and beverage manager.",
  },
  damage_cleaning: {
    action: "explain_no_refund",
    escalation: "manager",
    explanation:
      "Damage and cleaning fees are assessed by housekeeping. I can't waive them, " +
      "but I can have the manager review and follow up by email.",
  },
  late_checkout_fee: {
    action: "explain_policy_offer_goodwill",
    escalation: "manager",
    explanation:
      `Late checkout past noon is ${usd(PRICING.lateCheckout)}. ` +
      "If this is your first time I can waive it as a one-time courtesy.",
  },
  cancellation_fee: {
    action: "explain_policy_offer_goodwill",
    escalation: "manager",
    explanation:
      `Our policy is free cancellation up to ${PRICING.cancellationWindowHours} hours before ` +
      "check-in. Inside that window it's one night. If you're a returning guest I can waive it once.",
  },
  no_show: {
    action: "explain_no_refund",
    escalation: "manager",
    explanation:
      "This room was guaranteed to your card and there's no cancellation on record, " +
      "so it was held for you and charged as a no-show under the guarantee policy. " +
      "I can't reverse a guaranteed charge myself, but I can have the manager review " +
      "it and follow up by email.",
  },
  double_charge_billing_error: {
    action: "correct_immediately_or_open_ticket",
    escalation: "accounting",
    explanation:
      "If I can see the duplicate I'll refund it right now. " +
      "Otherwise accounting will open a ticket and email you within two business days.",
  },
  other: {
    action: "verify_explain_then_offer_credit",
    escalation: "manager",
    explanation: "Let me look into that and offer a fair resolution.",
  },
};

export interface DisputeVerdict {
  outcome: DisputeOutcome;
  /** Cents back to the card — clamped to the line item by construction. */
  refund: number;
}

/**
 * Their `_resolve_dispute_outcome`. `accepts` is whether the caller took the
 * resolution the policy offers; a refund is never larger than the line item
 * because it IS the line item's amount or nothing.
 */
export function resolveDisputeOutcome(
  policy: DisputePolicy,
  amount: number,
  lineItemLabel: string,
  invoiceLineItems: readonly LineItem[],
  accepts: boolean,
): DisputeVerdict {
  switch (policy.action) {
    case "auto_refund_if_under_threshold":
      if (amount <= PRICING.minibarAutoRefundThreshold)
        return { outcome: "auto_refunded", refund: amount };
      return accepts
        ? { outcome: "credit_offered", refund: amount }
        : { outcome: "escalated_to_manager", refund: 0 };
    case "verify_explain_then_offer_credit":
      return accepts
        ? { outcome: "credit_offered", refund: amount }
        : { outcome: "escalated_to_manager", refund: 0 };
    case "explain_no_refund":
      return accepts
        ? { outcome: "explained_no_action", refund: 0 }
        : { outcome: "escalated_to_manager", refund: 0 };
    case "explain_policy_offer_goodwill":
      return accepts
        ? { outcome: "goodwill_waived", refund: amount }
        : { outcome: "escalated_to_manager", refund: 0 };
    case "correct_immediately_or_open_ticket": {
      const same = invoiceLineItems.filter(
        (li) => li.label === lineItemLabel && li.amount === amount,
      ).length;
      return same > 1
        ? { outcome: "auto_refunded", refund: amount }
        : { outcome: "accounting_ticket_opened", refund: 0 };
    }
    default:
      // Unreachable while `DISPUTE_POLICIES` is the only source of a policy; a
      // corrupted one is refused rather than silently filed as `open`.
      throw new Error(`unknown dispute action: ${String(policy.action)}`);
  }
}

/** Their `_say_dispute_outcome`: the sentence the receptionist reads for each outcome. */
export function sayDisputeOutcome(
  verdict: DisputeVerdict,
  caseNumber: string,
  lineItem: string,
  policy: DisputePolicy,
): string {
  const spokenCase = speakCode(caseNumber);
  switch (verdict.outcome) {
    case "auto_refunded":
      return (
        `I've removed the ${lineItem} charge - that's ${speakUsd(verdict.refund)} back to the card. ` +
        `Case number ${spokenCase} if you need to reference it.`
      );
    case "credit_offered":
      return `Applied a ${speakUsd(verdict.refund)} credit toward the ${lineItem}. Case number ${spokenCase}.`;
    case "goodwill_waived":
      return `Waived as a one-time courtesy - ${speakUsd(verdict.refund)} back to the card. Case number ${spokenCase}.`;
    case "explained_no_action":
      return policy.explanation;
    case "escalated_to_manager":
      return (
        "I've escalated this to the manager - they'll review and follow up by email. " +
        `Your case number is ${spokenCase}.`
      );
    case "accounting_ticket_opened":
      return (
        "I've opened an accounting ticket. They'll investigate and email you within two business days. " +
        `Case number ${spokenCase}.`
      );
    default:
      return `Logged. Case number ${spokenCase}.`;
  }
}
