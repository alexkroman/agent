import { isToolFailure, resolveOne, toolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import {
  DISPUTE_POLICIES,
  LINE_ITEM_PICK,
  resolveDisputeOutcome,
  sayDisputeOutcome,
} from "../disputes.ts";
import { invoiceFor } from "../hotel.ts";
import { DISPUTE_CATEGORIES, mintCode } from "../records.ts";
import { hotelSlot } from "../session.ts";
import { note, requireVerified, takenCodes } from "../shared.ts";

/**
 * Handle a dispute on a line item — their `dispute_charge`.
 *
 * The model supplies the CATEGORY and whether the caller accepted the policy's
 * offer; the amount is read off the stored line item, the outcome comes from
 * `disputes.ts`, and a refund decrements the invoice where it is filed.
 *
 * **Which line is `resolveOne`'s**, on `LINE_ITEM_PICK` — an ordinal ("the
 * second one", off a folio the desk has just read out), then the label's own
 * words, then a refusal listing the lines with their amounts. What this file
 * had was an exact case-folded `===` and a hand-written listing beside it, so
 * "the minibar charge" missed `Minibar - still water` and came back asking the
 * caller to pick from a list they had already picked from.
 */
export default hotelSlot.updateTool({
  description:
    "File a dispute on one invoice line item for the verified caller and apply the policy outcome. " +
    "Call lookup_invoice FIRST and read the lines back; then pass the line the CALLER named, in " +
    'their words - a label, part of one, or "the second one". Set acceptsOfferedResolution true ' +
    "ONLY after the caller has actually accepted what you offered (a waiver, a credit); false if they " +
    "pushed back, asked for a manager, or haven't been offered anything yet.",
  inputSchema: z.object({
    category: z
      .enum(DISPUTE_CATEGORIES)
      .describe("The category that best matches what is disputed"),
    lineItemLabel: z
      .string()
      .describe('The invoice line as the caller referred to it - a label, or "the second one"'),
    callerNote: z
      .string()
      .max(300)
      .describe("What the caller said about the charge, in one sentence"),
    acceptsOfferedResolution: z.boolean(),
  }),
  execute({ category, lineItemLabel, callerNote, acceptsOfferedResolution }, hotel) {
    const booking = requireVerified(hotel);
    if (isToolFailure(booking)) return booking;
    const invoice = invoiceFor(hotel, booking.code);
    if (invoice === undefined) return toolFailure(`no invoice on file for ${booking.code}`);
    const item = resolveOne(invoice.lineItems, lineItemLabel, LINE_ITEM_PICK);
    if (isToolFailure(item)) return item;
    const policy = DISPUTE_POLICIES[category];
    const verdict = resolveDisputeOutcome(
      policy,
      item.amount,
      item.label,
      invoice.lineItems,
      acceptsOfferedResolution,
    );
    const caseNumber = mintCode("DSP", takenCodes(hotel));
    hotel.disputes.push({
      caseNumber,
      bookingCode: booking.code,
      lineItem: item.label,
      amount: item.amount,
      category,
      callerNote,
      outcome: verdict.outcome,
      refundAmount: verdict.refund,
      status:
        verdict.outcome === "escalated_to_manager" || verdict.outcome === "accounting_ticket_opened"
          ? "open"
          : "resolved",
    });
    if (verdict.refund > 0) {
      const live = hotel.invoices.find((i) => i.bookingCode === booking.code);
      if (live) live.total -= verdict.refund;
    }
    note(hotel, `Dispute ${caseNumber} on ${item.label}: ${verdict.outcome}`);
    return {
      caseNumber,
      outcome: verdict.outcome,
      refund: verdict.refund,
      escalation: policy.escalation,
      say: sayDisputeOutcome(verdict, caseNumber, item.label, policy),
    };
  },
});
