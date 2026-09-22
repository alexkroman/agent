/**
 * The front desk's ROSTER — who can speak on this call — and the account slot
 * every desk reads.
 *
 * This template is the worked example for `agent({ personas })`: three personas
 * over ONE session, ONE history and ONE slot store. Triage answers the phone;
 * billing and support each own tools the other cannot call; a handoff is what
 * swaps who is speaking, and the caller hears one continuous conversation.
 *
 * Two ways the swap happens here, and both are on purpose:
 *
 * - **In code, when the tool IS the decision.** `tools/verify_account.ts`
 *   verifies the caller and hands them to whichever desk they asked for in the
 *   same call — `desk.handoff(ctx, needs, { note })`. The model never has to
 *   remember to make a second call.
 * - **By the model, when the caller's words are.** The roster mints a
 *   `handoff` tool whose description is each persona's `description` below,
 *   so "my internet is down" can reach support without a script for it.
 *
 * Every persona's tools are declared HERE, as a map on the persona, rather than
 * as files under `tools/` — that directory is every persona's, and a persona's
 * map is the strictly narrower set one desk owns. The gate is at execution: a
 * billing tool called while triage speaks answers a refusal naming who is and
 * how to hand off — a result the model reads, on every transport.
 */
import {
  type DeepReadonly,
  type PersonaDef,
  type Personas,
  persona,
  personas,
  sessionSlot,
  tool,
} from "@alexkroman1/aai";
import { type ToolFailure, toolFailure } from "@alexkroman1/aai/utils";
import { z } from "zod";

// ─── The book of accounts (a fixture, standing in for a CRM) ────────────────

export interface Invoice {
  id: string;
  amount: number;
  status: "open" | "paid" | "refunded";
}

export interface Account {
  number: string;
  zip: string;
  name: string;
  invoices: Invoice[];
  /** What the line diagnostic answers — "healthy", or the fault it finds. */
  line: "healthy" | "no-signal" | "intermittent";
}

export const ACCOUNTS: readonly Account[] = [
  {
    number: "1001",
    zip: "94107",
    name: "Dana",
    invoices: [
      { id: "INV-1001-1", amount: 59.0, status: "paid" },
      { id: "INV-1001-2", amount: 79.5, status: "open" },
    ],
    line: "intermittent",
  },
  {
    number: "2002",
    zip: "10001",
    name: "Sam",
    invoices: [{ id: "INV-2002-1", amount: 45.0, status: "open" }],
    line: "no-signal",
  },
];

export function findAccount(number: string, zip: string): Account | undefined {
  return ACCOUNTS.find((one) => one.number === number && one.zip === zip);
}

// ─── Session state ───────────────────────────────────────────────────────────

/** What this call has established about the caller. */
export interface Desk {
  /** Set by `verify_account`; every billing and support tool needs it. */
  verified?: { number: string; name: string };
  /** Refunds issued on this call, by invoice id. */
  refunded: string[];
  /** A technician visit booked on this call. */
  appointment?: { day: string; window: string };
}

export const deskSlot = sessionSlot("desk", (): Desk => ({ refunded: [] }), {
  view: (desk) => ({
    verified: desk.verified?.name,
    refunded: desk.refunded.length,
    appointment: desk.appointment,
  }),
});

/** The one answer every desk gives an unverified caller. */
export const NOT_VERIFIED = toolFailure(
  "The caller is not verified. Ask for their account number and zip code and call verify_account first.",
);

/** The verified account, or the refusal above. */
export function verifiedAccount(desk: DeepReadonly<Desk>): Account | ToolFailure {
  if (desk.verified === undefined) return NOT_VERIFIED;
  const account = ACCOUNTS.find((one) => one.number === desk.verified?.number);
  return account ?? NOT_VERIFIED;
}

// ─── The personas ────────────────────────────────────────────────────────────

/** Who answers the phone. No tools of its own: `tools/verify_account.ts` is everyone's. */
export const triage: PersonaDef = persona({
  name: "triage",
  description: "Answers the phone, verifies the caller and works out which desk they need",
  systemPrompt: [
    "You are the front desk. Find out whether the caller has a BILLING question",
    "(invoices, payments, refunds) or a SUPPORT problem (their line, their equipment),",
    "ask for their account number and zip code, and verify them. verify_account",
    "hands the caller to the right desk for you — do not call handoff as well.",
    "If someone says their service is down, they may go straight to support",
    "without verifying: hand off, and support will verify them.",
  ].join(" "),
});

export const billing = persona({
  name: "billing",
  description: "Invoices, payments and refunds for a verified caller",
  systemPrompt: [
    "You are the billing desk. Speak about invoices, payments and refunds only.",
    "Read amounts back before acting on them. A refund is final: confirm the",
    "invoice with the caller before issuing one. If the caller turns out to have a",
    "line or equipment problem, hand them to support.",
  ].join(" "),
  tools: {
    lookup_invoice: deskSlot.tool({
      description: "List the caller's invoices, or one invoice by id.",
      inputSchema: z.object({
        invoiceId: z.string().optional().describe("One invoice; omit to list all of them."),
      }),
      execute({ invoiceId }, desk) {
        const account = verifiedAccount(desk);
        if ("error" in account) return account;
        const invoices =
          invoiceId === undefined
            ? account.invoices
            : account.invoices.filter((one) => one.id === invoiceId);
        if (invoices.length === 0) return toolFailure(`No invoice ${invoiceId} on this account.`);
        return {
          invoices: invoices.map((one) => ({
            ...one,
            status: desk.refunded.includes(one.id) ? "refunded" : one.status,
          })),
        };
      },
    }),
    issue_refund: deskSlot.updateTool({
      description:
        "Refund one invoice in full. Only after the caller has confirmed the invoice id and amount.",
      inputSchema: z.object({ invoiceId: z.string() }),
      execute({ invoiceId }, desk) {
        const account = verifiedAccount(desk);
        if ("error" in account) return account;
        const invoice = account.invoices.find((one) => one.id === invoiceId);
        if (!invoice) return toolFailure(`No invoice ${invoiceId} on this account.`);
        if (invoice.status === "refunded" || desk.refunded.includes(invoiceId)) {
          return toolFailure(`${invoiceId} has already been refunded.`);
        }
        desk.refunded.push(invoiceId);
        return { refunded: invoiceId, amount: invoice.amount };
      },
    }),
  },
  // The two model knobs a persona may set: billing reads numbers back, so it
  // runs cooler than the front desk.
  temperature: 0.2,
});

export const support = persona({
  name: "support",
  description: "Line and equipment faults: diagnostics and technician visits",
  systemPrompt: [
    "You are technical support. Diagnose the line before proposing anything, and",
    "book a technician only when the diagnostic says the fault is on our side.",
    "If the caller wants to talk about a bill instead, hand them to billing.",
  ].join(" "),
  tools: {
    run_diagnostic: deskSlot.tool({
      description: "Test the caller's line and report what it finds.",
      inputSchema: z.object({}),
      execute(_args, desk) {
        const account = verifiedAccount(desk);
        if ("error" in account) return account;
        return {
          line: account.line,
          needsTechnician: account.line !== "healthy",
        };
      },
    }),
    schedule_technician: deskSlot.updateTool({
      description: "Book a technician visit. Only after run_diagnostic reported a fault.",
      inputSchema: z.object({
        day: z.string().describe("The day, as the caller said it."),
        window: z.enum(["morning", "afternoon"]),
      }),
      execute({ day, window }, desk) {
        const account = verifiedAccount(desk);
        if ("error" in account) return account;
        if (account.line === "healthy") {
          return toolFailure(
            "The diagnostic found no fault; there is nothing to send a technician for.",
          );
        }
        desk.appointment = { day, window };
        return { booked: desk.appointment };
      },
    }),
  },
});

/**
 * The roster. The FIRST entry answers the phone; the rest are who it can hand
 * the caller to, and each other. `agent.ts` declares it, every tool that hands
 * off imports it, and `agent.test.ts` reads who is speaking through it.
 */
export const desk: Personas = personas([triage, billing, support]);

/** A tool the front desk itself carries, for a spec to reach `tool()` beside the slot forms. */
export const whichDesk = tool({
  description: "Which desk is speaking right now.",
  inputSchema: z.object({}),
  execute: (_args, ctx) => ({ persona: desk.active(ctx).name }),
});
