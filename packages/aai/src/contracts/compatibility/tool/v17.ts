// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:tool` epoch 17.
 *
 * A `tools/` module for a parcel desk: a zod input schema, a credential read
 * through {@link requireEnv}, a {@link ToolFailure} for the case the model
 * should recover from, and a body that budgets its own work against the
 * conversation's clock. Written the way it was authored at epoch 17, and it
 * must keep compiling for as long as that epoch is advertised as supported.
 *
 * ## What moved, and why epoch 17 survives it
 *
 * Epoch 18 ADDED a field to {@link ToolContext}: `deadlineAt`, the instant this
 * call's own deadline expires. The export list is unchanged — this is a
 * SIGNATURE change, and `ToolContext` is the one type in this capability that
 * reaches almost every member of the report.
 *
 * It is additive FOR A READER, which is what an agent author is. A tool body is
 * handed a context and reads it; a field it does not know about cannot break
 * that, and every tool below compiles untouched. What a new required field
 * would break is a caller that CONSTRUCTS a `ToolContext` by hand — and an
 * agent never does, because the runtime builds it. (A spec does, through
 * `createToolContext`, which is `aai:testing`'s surface and supplies the field
 * itself.)
 *
 * {@link quoteDelivery} reads the field anyway, because the interesting claim
 * is not that an old file still compiles but that the two styles COEXIST: an
 * epoch-17 tool that ignores the deadline and a tool that budgets against it
 * are the same `tool()` call.
 */

import { z } from "zod";
import {
  type InferToolInput,
  type InferToolOutput,
  isToolFailure,
  requireEnv,
  type ToolContext,
  type ToolDef,
  type ToolFailure,
  tool,
  toolFailure,
} from "../../../index.ts";

/** Room left under the deadline to write an answer the caller can hear. */
const WRAP_UP_MS = 1500;

interface Quote {
  service: string;
  pence: number;
}

/**
 * Look up one parcel's delivery options.
 *
 * The failure arm is a {@link ToolFailure} rather than a throw: an unknown
 * postcode is something the model should ask about, not an outage.
 */
export const quoteDelivery: ToolDef = tool({
  description: "Quote delivery options for a parcel to a UK postcode.",
  inputSchema: z.object({
    postcode: z.string().min(5).describe("The destination postcode"),
    grams: z.number().int().positive(),
  }),
  async execute({ postcode, grams }, ctx: ToolContext): Promise<Quote[] | ToolFailure> {
    // Declared in `requiredEnv`, so a missing key fails at deploy time; this
    // throw is the belt for a context that was built without it.
    const key = requireEnv(ctx, "PARCEL_API_KEY");

    // Budgeted against THIS call's deadline rather than a constant: a host that
    // gave this tool its own `timeoutMs` is followed rather than second-guessed.
    const budget = Math.max(0, ctx.deadlineAt - Date.now() - WRAP_UP_MS);
    const response = await fetch(`https://parcels.example/quote?to=${postcode}&g=${grams}`, {
      headers: { authorization: key },
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(budget)]),
    });
    if (!response.ok) {
      return toolFailure(`No quote for ${postcode} — check the postcode and try again.`);
    }
    return (await response.json()) as Quote[];
  },
});

/** A second tool, ignoring the deadline entirely — the epoch-17 shape. */
export const trackParcel: ToolDef = tool({
  description: "Say where a parcel has got to.",
  inputSchema: z.object({ tracking: z.string() }),
  execute({ tracking }, ctx) {
    const last = ctx.messages.at(-1);
    return { tracking, sessionId: ctx.sessionId, sawMessage: last !== undefined };
  },
});

/** The inference helpers an author uses to name a tool's own shapes. */
export type QuoteInput = InferToolInput<typeof quoteDelivery>;
export type QuoteOutput = InferToolOutput<typeof quoteDelivery>;

/** Narrowing a result the way a caller does. */
export function pence(result: Quote[] | ToolFailure): number {
  return isToolFailure(result) ? 0 : (result[0]?.pence ?? 0);
}
