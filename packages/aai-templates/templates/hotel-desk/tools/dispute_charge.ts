import { toolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { DISPUTE_POLICIES, resolveDisputeOutcome, sayDisputeOutcome } from "../disputes.ts";
import { invoiceFor } from "../hotel.ts";
import { DISPUTE_CATEGORIES, mintCode } from "../records.ts";
import { hotelSlot, note, requireVerified, takenCodes } from "../shared.ts";

/**
 * Handle a dispute on a line item — their `dispute_charge`.
 *
 * The model supplies the CATEGORY and whether the caller accepted the policy's
 * offer; the amount is read off the stored line item, the outcome comes from
 * `disputes.ts`, and a refund decrements the invoice where it is filed. Labels
 * are matched case-insensitively, so "late checkout" still finds "Late checkout".
 */
export default hotelSlot.updateTool({
  description:
    "File a dispute on one invoice line item for the verified caller and apply the policy outcome. " +
    "Call lookup_invoice FIRST so the line item label is exact. Set acceptsOfferedResolution true " +
    "ONLY after the caller has actually accepted what you offered (a waiver, a credit); false if they " +
    "pushed back, asked for a manager, or haven't been offered anything yet.",
  inputSchema: z.object({
    category: z
      .enum(DISPUTE_CATEGORIES)
      .describe("The category that best matches what is disputed"),
    lineItemLabel: z.string().describe("The invoice line, as it appears"),
    callerNote: z
      .string()
      .max(300)
      .describe("What the caller said about the charge, in one sentence"),
    acceptsOfferedResolution: z.boolean(),
  }),
  execute({ category, lineItemLabel, callerNote, acceptsOfferedResolution }, hotel) {
    const booking = requireVerified(hotel);
    if ("error" in booking) return toolFailure(booking.error);
    const invoice = invoiceFor(hotel, booking.code);
    if (invoice === undefined) return toolFailure(`no invoice on file for ${booking.code}`);
    const target = lineItemLabel.trim().toLowerCase();
    const item = invoice.lineItems.find((li) => li.label.toLowerCase() === target);
    if (item === undefined) {
      return toolFailure(
        `No line item labelled "${lineItemLabel}" on that invoice. The lines are: ` +
          `${invoice.lineItems.map((li) => li.label).join("; ")}. Read them back and ask the caller to pick one.`,
      );
    }
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
