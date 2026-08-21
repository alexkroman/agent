import type { ToolContext, ToolFailure } from "@alexkroman1/aai";
import { derivedFlow, isToolFailure, pushCapped, sessionSlot } from "@alexkroman1/aai";
import { setup } from "xstate";
import type { z } from "zod";
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
import { emptyRetailState, MAX_ACTIVITY } from "./shared.ts";

/**
 * The JSON import's inferred type has `status: string` where `Order` wants a
 * union, so a direct assignment can't type-check. The cast is validated once,
 * for real, by `seed.test.ts` — which parses this same file through a zod
 * schema — rather than by paying a 107 KB validation on every session start.
 */
const SEED = seedJson as unknown as Store;

/** Round to cents. Gift-card balances and price differences are compared for
 *  equality, and raw float arithmetic makes that a coin toss. */
export function money(n: number): number {
  return Math.round(n * 100) / 100;
}

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
 * The session's store, as one typed slot.
 *
 * Every tool goes through `retailSlot.updateTool` (via `retailTool`), so every
 * tool body is handed a mutable draft of the whole store and mutates it in
 * place: the ~106 KB of catalogue here is exactly the state a functional replace
 * would make unwritable without hand-built spread chains three levels deep.
 * What makes that safe is that the window is SYNCHRONOUS — the LLM loop runs a
 * step's tool calls concurrently, and a draft that cannot span an await cannot
 * interleave with another one.
 *
 * No `after` hook — unlike dispatch-center, this store has no derived field to
 * recalculate, and its one growth cap (`activity`) is held on append by
 * `record` below.
 */
export const retailSlot = sessionSlot("retail", createDefaultState);

// ─── The call, as a machine ──────────────────────────────────────────────────

/**
 * Where this call is, and what may be done from here.
 *
 * The policy's first two sections — "Authenticate first" and "Handing off to a
 * human" — used to be prose plus a boolean. `requiresAuth` was that boolean:
 * fifteen tools declared it (five opting out), the wrapper below read it, and a
 * refusal answered one fixed sentence. Three things change by declaring the
 * states instead.
 *
 * **`transferred` is a real terminal state, and it was not enforced at all.**
 * The policy says to call `transfer_to_human_agents` and then say exactly one
 * sentence "and nothing else" — which nothing checked, so every tool stayed
 * callable after the handoff and a model that kept going would keep acting on a
 * call it had already given away. It is a `final` state now: no tool declares
 * itself legal there, so every one of them refuses.
 *
 * **The refusal quotes the state.** `when` names where a tool may run and the
 * SDK writes the sentence, so the message is one thing rather than a constant
 * threaded through a wrapper — and it says where the call actually is, which
 * "Not authenticated" could not.
 *
 * **The position rides every result.** A flow tool answers the author's value
 * wrapped in the position it landed in, so the stage and its instruction reach
 * the model on every call rather than only when the prompt is still in context.
 *
 * `IDENTIFIED` is declared on `serving` as well, because a caller repeating
 * their email must not hit an error — see `authenticateAs`, which is what
 * refuses a switch to a DIFFERENT customer. Whether the flow is identified and
 * WHO it is identified as are two facts: this holds the first,
 * `authenticatedUserId` holds the second.
 */
const callMachine = setup({}).createMachine({
  id: "call",
  initial: "identifying",
  states: {
    identifying: {
      meta: {
        // The instruction NAMES the two tools, because this sentence is what a
        // refusal quotes and a refusal is the model's recovery path — the same
        // job the removed `NOT_AUTHENTICATED` constant did, now attached to the
        // state that means it.
        instruction:
          "You do not know who this is yet. Identify the caller with " +
          "find_user_id_by_email, or find_user_id_by_name_zip if they cannot " +
          "remember the email. Do this even if they volunteer a user id.",
      },
      on: { IDENTIFIED: "serving", TRANSFERRED: "transferred" },
    },
    serving: {
      meta: {
        instruction:
          "You are helping one identified customer, and only that one. Say what you " +
          "are about to change — the order, the items, the amounts, where the money " +
          "goes — and wait for an explicit yes before you call anything that changes it.",
      },
      on: { IDENTIFIED: "serving", TRANSFERRED: "transferred" },
    },
    transferred: {
      type: "final",
      meta: {
        instruction:
          "The call belongs to a human agent now. Say nothing beyond the transfer " +
          "sentence, and do nothing else.",
      },
    },
  },
});

/**
 * The flow, DERIVED from the store rather than stored beside it.
 *
 * The three positions were already three facts about the store — nobody
 * identified, one customer latched, handed to a human — so holding a second
 * copy in an actor snapshot bought nothing and cost the two `send`s the finders
 * and the transfer had to remember. `authenticatedUserId` is what `serving`
 * MEANS, which is why the `authenticatedUser` guard below is no longer a second
 * reading of the same question: it and the gate now read one field.
 */
export const callFlow = derivedFlow(callMachine, retailSlot, (state) => {
  if (state.transferred) return "transferred";
  return state.authenticatedUserId === null ? "identifying" : "serving";
});

/** Every state a tool may run in before the call is handed to a human — i.e.
 *  everything but `transferred`. What the five formerly `requiresAuth: false`
 *  tools declare, so the terminal state gates them without an auth gate. */
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
 * reason `travel-concierge`'s `cancel_action` keeps its own: this runs mid-call,
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

// ─── The tool wrapper ────────────────────────────────────────────────────────

interface RetailToolSpec<S extends z.ZodType<Record<string, unknown>>, R> {
  /** Must equal this tool's key in `agent.ts`. `agent.test.ts` asserts it. */
  name: string;
  description: string;
  /** Required even for no-arg tools — pass `z.object({})`. One code path in the
   *  wrapper is worth more than saving a line at one call site. */
  inputSchema: S;
  /**
   * The state(s) this tool may run in, as `callFlow`'s states spell them.
   *
   * Replaces the `requiresAuth` boolean this spec used to carry. Ten tools want
   * `"serving"`; the two finders, the three catalog reads and the transfer want
   * {@link BEFORE_TRANSFER}, which is every state but the terminal one — so
   * "does not need a customer" and "is still legal after the handoff" stopped
   * being the same claim, and they were never the same claim.
   */
  when: string | readonly string[];
  summary: (args: z.output<S>, result: R) => string;
  /**
   * Handed the store as its second argument, and SYNCHRONOUS.
   *
   * **Declare it BEFORE `summary` in the object literal.** TS infers this
   * wrapper's generic `R` from `execute`'s return type and processes an object
   * literal's properties in SOURCE ORDER, so with `summary` written first its
   * `result` parameter has nothing to infer from and silently falls back to
   * `unknown` — every `isToolFailure(result) ? … : result.order_id` in the
   * fifteen tool files then stops compiling, or worse, stops meaning anything.
   * It lives here rather than in each tool file because it is a property of
   * this type: the same four lines were pasted into eight of the fifteen and
   * pointed at from five more, which is a rule maintained in fourteen places.
   *
   * ---
   *
   * **The draft is passed in rather than re-read**, which is the one change the
   * durable store forced on this template. The body used to open with
   * `retailSlot.get(ctx)`; under the draft write model that returns the value as
   * it was BEFORE this call, frozen, so a body that mutated it would be writing
   * to something nothing was going to store. Passing it removes the possibility
   * rather than documenting it.
   *
   * Synchronous for the same reason: the window cannot span an await — see
   * {@link SessionSlot.update}. Every tool here is a pure function of the store,
   * so none of them wants to; a tool that DID would await outside the wrapper and
   * call `retailSlot.update` itself, the way `plan-and-execute`'s do.
   */
  execute: (args: z.output<S>, state: RetailState, ctx: ToolContext) => R;
}

function record(state: RetailState, name: string, summary: string): void {
  state.callSeq += 1;
  pushCapped(
    state.activity,
    { seq: state.callSeq, tool: name, summary, at: Date.now() },
    MAX_ACTIVITY,
  );
}

/**
 * Every retail tool is built through this. It owns two things no tool body may
 * re-implement:
 *
 * 1. the mutation window the body's draft comes from,
 * 2. the `callSeq` increment + activity entry — the reason the UI moves on
 *    every tool call rather than only when a projected value happens to differ.
 *
 * The third thing it used to own — the authentication gate — is
 * {@link callFlow}'s now, declared per tool as `when`. What that buys is in the
 * machine's own doc; what it COSTS is one line of the activity feed: a refused
 * call short-circuits before this wrapper's body runs, so a blocked call no
 * longer records `blocked: not authenticated` and no longer bumps `callSeq`.
 * That is the right trade — the refusal reaches the model, which the sidebar
 * line never did, and it carries the state and its instruction rather than one
 * fixed sentence.
 *
 * **`callFlow.tool` rather than `retailSlot.updateTool`**, so the body opens the
 * store's window itself. A flow tool's own `execute` is handed `(args, ctx)`;
 * everything else about a tool body here is unchanged, including that it is
 * synchronous — the window cannot span an await.
 *
 * `focus` is deliberately left to tool bodies (`setFocus`): it is a UI nicety,
 * not an invariant, and only the body knows what the call was about.
 */
export function retailTool<S extends z.ZodType<Record<string, unknown>>, R>(
  spec: RetailToolSpec<S, R>,
) {
  return callFlow.tool({
    description: spec.description,
    inputSchema: spec.inputSchema,
    when: spec.when,
    execute: (args, ctx) =>
      retailSlot.update(ctx, (state) => {
        const typedArgs = args as z.output<S>;
        const result = spec.execute(typedArgs, state, ctx);
        record(
          state,
          spec.name,
          isToolFailure(result) ? `error: ${result.error}` : spec.summary(typedArgs, result),
        );
        return result;
      }),
  });
}
