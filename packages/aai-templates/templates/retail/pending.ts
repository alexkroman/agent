/**
 * The change waiting on the caller's word — what is staged, and what applying
 * it does.
 *
 * Retail's policy has always said "confirm every change out loud … never act on
 * an implied yes", and for a long time the only thing carrying that was prose:
 * the sentence sat in the system prompt and in seven tool descriptions, and
 * `cancel_pending_order` cancelled and refunded on its first call whether or not
 * a word had been said. A rule enforced by asking a model nicely is not a rule.
 *
 * It is a MECHANISM now, and the mechanism is two halves that need each other:
 *
 * 1. **No tool mutates.** The seven changing tools validate everything, price
 *    it, write a {@link PendingAction} here and return the sentence to read
 *    back. `confirm_change` is the only thing in the template that writes to
 *    the store.
 * 2. **`confirm_change` is gated on a STATE.** `callFlow`'s
 *    `serving.awaitingConfirmation` (`store.ts`) is reachable only by staging,
 *    so confirming a change nobody staged is refused by the SDK before the body
 *    runs — and the refusal says where the call is and what has to happen first.
 *
 * The half that is not enforceable stays honest about it: nothing here can know
 * that the agent really SAID the sentence, or that the caller really answered
 * yes. What the gate buys is that a change cannot happen in the same turn it was
 * described in — the model has to come back for a second call, with the caller's
 * answer in between — which is the property the prose could not have.
 *
 * Adapted from `travel-concierge`, whose `stageAction`/`confirm_action` pair is
 * the same shape one domain over. The difference worth noting: its plans are
 * re-derived at confirm time, and these are computed once at stage time and held
 * as primitives. That is deliberate — see `cancel.ts`. A "yes" must never be
 * followed by a refusal.
 */

import type { ToolFailure } from "@alexkroman1/aai";
import type { OrderAddressPlan, UserAddressPlan } from "./address.ts";
import { applyOrderAddress, applyUserAddress } from "./address.ts";
import { applyCancel, type CancelPlan } from "./cancel.ts";
import { applyPayment, type PaymentPlan } from "./payment.ts";
import { applyReturn, type ReturnPlan } from "./returns.ts";
import type { RetailState } from "./shared.ts";
import type { ExchangePlan, ModifyItemsPlan } from "./swap.ts";
import { applyExchange, applyModifyItems } from "./swap.ts";

/**
 * A validated, priced, not-yet-applied change.
 *
 * `kind` is the NAME OF THE TOOL that staged it, so the activity feed, the
 * sidebar and every refusal can say which change is waiting in the same words
 * the model called it by.
 */
export type PendingAction =
  | { kind: "cancel_pending_order"; plan: CancelPlan }
  | { kind: "modify_pending_order_address"; plan: OrderAddressPlan }
  | { kind: "modify_pending_order_items"; plan: ModifyItemsPlan }
  | { kind: "modify_pending_order_payment"; plan: PaymentPlan }
  | { kind: "modify_user_address"; plan: UserAddressPlan }
  | { kind: "return_delivered_order_items"; plan: ReturnPlan }
  | { kind: "exchange_delivered_order_items"; plan: ExchangePlan };

/** What a staging tool answers with: the sentence, and nothing done yet. */
export interface StagedResult {
  staged: PendingAction["kind"];
  read_back: string;
  message: string;
}

/**
 * Put a change in front of the caller.
 *
 * A SECOND stage is refused rather than queued, and the refusal names the
 * sentence already waiting — which is the whole reason the staging tools are
 * gated on `serving` (either child) rather than on `serving.helping`. A state
 * gate could only say "you are at serving.awaitingConfirmation", a state's
 * instruction being static; this can say *which* change is waiting, which is
 * what lets the model settle that one and re-stage the other. Same resolution
 * as `travel-concierge`, and for the same reason.
 */
export function stageAction(state: RetailState, action: PendingAction): StagedResult | ToolFailure {
  const waiting = state.pending;
  if (waiting) {
    return {
      error:
        `A change is already waiting on the caller's yes: "${waiting.plan.readBack}". ` +
        "Settle that one with confirm_change or cancel_change, then stage this one.",
    };
  }
  state.pending = action;
  return {
    staged: action.kind,
    read_back: action.plan.readBack,
    message:
      `NOTHING HAS CHANGED YET. Read this back to the caller — "${action.plan.readBack}" — ` +
      "and wait for an explicit yes. Then call confirm_change, or cancel_change if they say no.",
  };
}

/**
 * Perform the staged change.
 *
 * Total: every plan was validated against this same store, and nothing between
 * staging and confirming can invalidate one — `confirm_change` and
 * `cancel_change` are the only tools legal in `awaitingConfirmation`, and
 * neither is a mutation the other's plan depends on. That totality is the
 * point. An `applyAction` that could fail would mean a caller saying yes and
 * hearing "actually, no", which is exactly the outcome staging exists to
 * prevent.
 */
export function applyAction(state: RetailState, action: PendingAction) {
  switch (action.kind) {
    case "cancel_pending_order":
      return applyCancel(state, action.plan);
    case "modify_pending_order_address":
      return applyOrderAddress(state, action.plan);
    case "modify_pending_order_items":
      return applyModifyItems(state, action.plan);
    case "modify_pending_order_payment":
      return applyPayment(state, action.plan);
    case "modify_user_address":
      return applyUserAddress(state, action.plan);
    case "return_delivered_order_items":
      return applyReturn(state, action.plan);
    case "exchange_delivered_order_items":
      return applyExchange(state, action.plan);
    default: {
      // Unreachable: the seven arms above exhaust `PendingAction`, and this
      // ASSIGNMENT is what keeps that true — an eighth member of the union
      // stops compiling here rather than falling silently through to a change
      // nobody applies. It exists because biome's `useDefaultSwitchClause`
      // wants an arm, not because a call can reach it, which is why it throws
      // rather than answering the `ToolFailure` the rest of this template
      // prefers: there is no live call on this path to recover.
      const unreachable: never = action;
      throw new Error(`No apply for staged action ${JSON.stringify(unreachable)}`);
    }
  }
}
