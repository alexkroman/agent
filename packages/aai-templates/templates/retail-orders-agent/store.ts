import type { ToolFailure } from "@alexkroman1/aai";
import { dialog, isToolFailure, sessionSlot } from "@alexkroman1/aai";
import { isRecord, roundMoney, safeJsonParse } from "@alexkroman1/aai/utils";
import seedJson from "./seed.json";
import type {
  GiftCard,
  Order,
  PaymentMethod,
  Product,
  RetailState,
  Store,
  User,
  Variant,
} from "./shared.ts";
import { emptyRetailState, MAX_ACTIVITY, storeView } from "./shared.ts";

/**
 * The JSON import's inferred type has `status: string` where `Order` wants a
 * union, so a direct assignment can't type-check. The cast is validated once,
 * for real, by `seed.test.ts` — which parses this same file through a zod
 * schema — rather than by paying a 107 KB validation on every session start.
 */
const SEED = seedJson as unknown as Store;

/**
 * Round to cents. Gift-card balances and price differences are compared for
 * equality, and raw float arithmetic makes that a coin toss.
 *
 * `roundMoney`'s now. The `Math.round(n * 100) / 100` this was disagrees with
 * `formatMoney` on a half-cent — 2.675 rounds to 2.68 here and prints as
 * `$2.67` — so a total could compare as one number and read as another.
 */
export const money = roundMoney;

export function isGiftCard(method: PaymentMethod): method is GiftCard {
  return method.source === "gift_card";
}

// ─── Session state ───────────────────────────────────────────────────────────

/** A pristine store per session. The deep clone is load-bearing: `SEED` is one
 *  module-level object shared by every session in the process, so a mutation
 *  without it would let one caller's cancellation show up in another's. */
export function createDefaultState(): RetailState {
  return { ...emptyRetailState(), store: seedStore() };
}

/**
 * A pristine deep copy of the seed store.
 *
 * Exported so a caller needs no cast of its own. `shared.test.ts` had written
 * `structuredClone(seedJson) as unknown as Store` twice — a second and third
 * copy of the narrowing this module already owns, each of which would keep
 * compiling if `Store` grew a field the JSON does not carry. The one cast is
 * `SEED`'s above, and `seed.test.ts` is what makes it honest.
 */
export function seedStore(): Store {
  return structuredClone(SEED);
}

/**
 * The session's store, as one typed slot. Every tool is a
 * `retailSlot.updateTool`, handed a mutable draft of the whole store inside the
 * slot's synchronous window. `empty` is what the slot projects for a session
 * that has run no tool — the shape with nothing in it, never the seed — and it
 * is the same frame `client.tsx` builds for itself, since that file must not
 * import this one (the 107 KB seed would ship to the browser).
 */
export const retailSlot = sessionSlot("retail", createDefaultState, {
  // What the browser sees: only the authenticated customer of the six seeded.
  view: storeView,
  sync: true,
  empty: emptyRetailState,
  caps: { activity: MAX_ACTIVITY },
});

// ─── The call, as a machine ──────────────────────────────────────────────────

/**
 * Where this call is, and what may be done from here, as a plain state map.
 *
 * A {@link DialogSpec} rather than an XState machine: everything this dialog
 * says is states, events and an instruction each, which is exactly what a spec
 * can say. The instruction is a declared field instead of an untyped `meta`
 * bag, so misspelling it is a compile error rather than a refusal that arrives
 * with no recovery text. `as const` is what keeps the `on` keys literal, so
 * `send` below is checked against the events this spec actually declares.
 *
 * Three of the policy's sections live here rather than in prose.
 *
 * **"Authenticate first."** `identifying`'s instruction names both finder
 * tools, and ten tools declare `when: "serving"`, so the gate is the SDK's.
 *
 * **"Handing off to a human."** The policy says to call
 * `transfer_to_human_agents` and then say exactly one sentence "and nothing
 * else" — which nothing checked, so every tool stayed callable after the handoff
 * and a model that kept going kept acting on a call it had already given away.
 * `transferred` is a `final` state: no tool declares itself legal there, so
 * every one of them refuses. `TRANSFERRED` sits on the `serving` PARENT so it
 * is reachable from either child — a caller asking for a human mid-confirmation
 * must get one.
 *
 * **"Confirm every change out loud."** This was the last rule in the policy
 * carried by nothing at all, and it is `serving`'s two children now. Nothing in
 * this template mutates the store except `confirm_change`, which is legal only
 * in `awaitingConfirmation`, which is reachable only by staging a change. See
 * `pending.ts` for what that buys and what it still cannot promise.
 *
 * **`IDENTIFIED` is deliberately NOT declared on `serving`.** It was, while
 * `serving` was a leaf, so that a caller repeating their email did not hit an
 * error. Now that `serving` has children, a self-transition would RE-ENTER it
 * and reset to `helping` — stranding a staged change that `state.pending` still
 * holds, which is the one way the position and the store could come to
 * disagree. An event no active state handles is ignored, and ignoring it is
 * exactly right: re-identifying the same customer does not move the call.
 * `authenticateAs` is what refuses a switch to a DIFFERENT customer. Whether
 * the call is identified and WHO it is identified as are two facts: this holds
 * the first, `authenticatedUserId` holds the second.
 */
const callSpec = {
  initial: "identifying",
  states: {
    identifying: {
      // The instruction NAMES the two tools, because this sentence is what a
      // refusal quotes and a refusal is the model's recovery path.
      instruction:
        "You do not know who this is yet. Identify the caller with " +
        "find_user_id_by_email, or find_user_id_by_name_zip if they cannot " +
        "remember the email. Do this even if they volunteer a user id.",
      on: {
        IDENTIFIED: "serving",
        TRANSFERRED: "transferred",
        "@session.timedOut": "abandoned",
      },
    },
    serving: {
      initial: "helping",
      // Declared on the PARENT, so it reaches `helping` and
      // `awaitingConfirmation` alike — a caller hangs up mid-confirmation more
      // often than anywhere else on this call. It targets a SIBLING rather than
      // itself, so it is not the re-entering self-transition the `IDENTIFIED`
      // note below refuses.
      on: { TRANSFERRED: "transferred", "@session.timedOut": "abandoned" },
      states: {
        helping: {
          instruction:
            "You are helping one identified customer, and only that one. Nothing is " +
            "waiting on their word. A tool that changes something only STAGES it and " +
            "hands you a sentence to read back.",
          on: { STAGED: "awaitingConfirmation" },
        },
        awaitingConfirmation: {
          instruction:
            "A change is staged and NOTHING HAS HAPPENED YET. Read the staged sentence " +
            "back — the order, the items, the amounts, where the money goes — and wait " +
            "for an explicit yes. Then call confirm_change, or cancel_change if they " +
            "say no or want to change any part of it.",
          on: { SETTLED: "helping" },
        },
      },
    },
    abandoned: {
      final: true,
      instruction:
        "The caller is gone. Do nothing further on this call — do not confirm a staged " +
        "change, do not look anything up, and do not promise a callback.",
    },
    transferred: {
      final: true,
      instruction:
        "The call belongs to a human agent now. Say nothing beyond the transfer " +
        "sentence, and do nothing else.",
    },
  },
} as const;

/**
 * The flow. Its own slot key beside {@link retailSlot}: the flow holds the
 * POSITION and the store holds the customer, the orders, the activity feed and
 * the staged change itself, because an inspectable {@link PendingAction} is
 * what `confirm_change` applies. One tool call always moves both — a staging
 * tool writes `pending` and sends `STAGED` in the same synchronous window.
 */
export const callFlow = dialog("call", callSpec);

/** Every state a tool may run in before the call is handed to a human — i.e.
 *  everything but `transferred`. What the two finders, the three catalog reads
 *  and the transfer itself declare as their `when`, so the terminal state gates
 *  them without an auth gate. `"serving"` matches both of its children, which
 *  is what keeps a read legal while a change is waiting. */
export const BEFORE_TRANSFER = ["identifying", "serving"] as const;

export function setFocus(
  state: RetailState,
  focus: { orderId?: string; productId?: string },
): void {
  state.focus = { ...state.focus, ...focus };
}

// ─── Lookups ─────────────────────────────────────────────────────────────────

export function findUser(state: RetailState, userId: string): User | ToolFailure {
  return state.store.users[userId] ?? { error: `User ${userId} not found.` };
}

export function findOrder(state: RetailState, orderId: string): Order | ToolFailure {
  return state.store.orders[orderId] ?? { error: `Order ${orderId} not found.` };
}

export function findProduct(state: RetailState, productId: string): Product | ToolFailure {
  return (
    state.store.products[productId] ?? {
      error: `Product ${productId} not found. Note a product id is not an item id.`,
    }
  );
}

export function findVariant(product: Product, itemId: string): Variant | ToolFailure {
  return (
    product.variants[itemId] ?? {
      error: `Item ${itemId} is not a variant of ${product.name} (${product.product_id}).`,
    }
  );
}

/** Item ids carry no product reference, so finding one means scanning. */
export function findItem(
  state: RetailState,
  itemId: string,
): { product: Product; variant: Variant } | ToolFailure {
  for (const product of Object.values(state.store.products)) {
    const variant = product.variants[itemId];
    if (variant) return { product, variant };
  }
  return { error: `Item ${itemId} not found. Note an item id is not a product id.` };
}

export function findPaymentMethod(user: User, methodId: string): PaymentMethod | ToolFailure {
  return (
    user.payment_methods[methodId] ?? {
      error: `Payment method ${methodId} is not on this customer's profile. Available: ${Object.keys(
        user.payment_methods,
      ).join(", ")}.`,
    }
  );
}

// ─── Guards ──────────────────────────────────────────────────────────────────

/**
 * The customer on this call.
 *
 * The null arm is reachable only if the POSITION and the STORE disagree — the
 * flow says `serving` while nothing latched a user id — which no code path
 * produces, since `authenticateAs` is what both writes the id and lets the
 * `IDENTIFIED` event through. It is kept and reported rather than thrown for the
 * reason `travel-concierge-agent`'s `cancel_action` keeps its own: this runs mid-call,
 * and a sentence the model can act on beats an exception. The GATE that a
 * customer is identified at all is `callFlow`'s, declared per tool as `when`.
 */
export function authenticatedUser(state: RetailState): User | ToolFailure {
  if (!state.authenticatedUserId) {
    return {
      error:
        "No customer is latched onto this call yet. Identify them with " +
        "find_user_id_by_email, or find_user_id_by_name_zip if they cannot " +
        "remember their email.",
    };
  }
  return findUser(state, state.authenticatedUserId);
}

/**
 * Resolve an order that belongs to the authenticated customer.
 *
 * An order belonging to someone else and an order that does not exist share
 * one template on purpose: no "belongs to another customer" vs. "does not
 * exist" wording, no owner name, no product name — nothing that lets a
 * caller learn something they did not already know. The echoed `orderId` is
 * the caller's own input, not information about the store, so keeping it
 * matches every sibling lookup (`findUser`, `findOrder`, `findProduct`, …),
 * which all echo the id precisely so an LLM can target a repair retry.
 */
export function requireOwnOrder(state: RetailState, orderId: string): Order | ToolFailure {
  const user = authenticatedUser(state);
  if (isToolFailure(user)) return user;
  const order = state.store.orders[orderId];
  if (!order || order.user_id !== user.user_id) {
    return { error: `Order ${orderId} was not found on this customer's account.` };
  }
  return order;
}

/**
 * The authenticated customer, when `userId` names them.
 *
 * The wrapper's auth gate says a customer is on the call; a tool whose schema
 * takes a `user_id` also needs to know the caller named THAT customer, and only
 * one message is right for the second. Two tools had the pair of guards written
 * out, so the message was maintained in two places — the same reason
 * {@link requireOwnOrder} exists one rule up.
 */
export function requireOwnUser(state: RetailState, userId: string): User | ToolFailure {
  const user = authenticatedUser(state);
  if (isToolFailure(user)) return user;
  if (user.user_id !== userId) {
    return {
      error: `${userId} is not the customer on this call. You can help only one customer per conversation.`,
    };
  }
  return user;
}

// ─── The activity feed ───────────────────────────────────────────────────────

/**
 * One line of the activity feed, and the `callSeq` bump the sidebar moves on.
 *
 * Written by the `tool.called` hook in `agent.ts`, for EVERY call the model
 * makes — the ones the gate refuses included, which no tool body could record
 * because a refusal short-circuits before the body. The summary is filled in
 * by the `tool.completed` hook once the result is known.
 */
export function record(
  state: RetailState,
  tool: string,
  at: number,
  callId: string,
  summary = "running",
): void {
  state.callSeq += 1;
  state.activity.push({ seq: state.callSeq, tool, summary, at, callId });
}

/**
 * The line a finished call gets, read off the result the model was handed:
 * the refusal or error for a failure, the sentence read back for a staged
 * change, and what was settled for the two settling tools.
 */
export function summarize(result: string): string {
  const parsed = safeJsonParse(result);
  if (isToolFailure(parsed)) return `error: ${parsed.error}`;
  if (!isRecord(parsed)) return "done";
  // A gated tool answers the dialog's envelope; the tool's own value is under `result`.
  const own = "result" in parsed ? parsed.result : parsed;
  if (!isRecord(own)) return "done";
  if ("read_back" in own) return `staged: ${String(own.read_back)}`;
  if ("confirmed" in own) return `confirmed ${String(own.confirmed)}`;
  if ("dropped" in own) return `dropped ${String(own.dropped ?? "nothing")}`;
  if ("transferred" in own) return "transferred to a human agent";
  return "done";
}
