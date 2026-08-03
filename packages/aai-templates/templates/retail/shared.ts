// ─── Store types ─────────────────────────────────────────────────────────────
// Field names are tau2's snake_case verbatim, because `seed.json` is tau2's
// records unmodified. Renaming them here would mean transforming 107 KB of
// data on every session start for cosmetics.

export interface Address {
  address1: string;
  address2: string;
  city: string;
  state: string;
  country: string;
  zip: string;
}

export interface GiftCard {
  source: "gift_card";
  id: string;
  balance: number;
}
export interface PayPal {
  source: "paypal";
  id: string;
}
export interface CreditCard {
  source: "credit_card";
  id: string;
  brand: string;
  last_four: string;
}
export type PaymentMethod = GiftCard | PayPal | CreditCard;

export interface Variant {
  item_id: string;
  options: Record<string, string>;
  available: boolean;
  price: number;
}

export interface Product {
  name: string;
  product_id: string;
  variants: Record<string, Variant>;
}

export interface OrderItem {
  name: string;
  product_id: string;
  item_id: string;
  price: number;
  options: Record<string, string>;
}

/** tau2's exact status strings. `pending (item modified)` is terminal — see
 *  `modify_pending_order_items`. */
export type OrderStatus =
  | "pending"
  | "pending (item modified)"
  | "processed"
  | "delivered"
  | "cancelled"
  | "return requested"
  | "exchange requested";

export interface OrderPayment {
  transaction_type: "payment" | "refund";
  amount: number;
  payment_method_id: string;
}

export interface Fulfillment {
  tracking_id: string[];
  item_ids: string[];
}

export interface Order {
  order_id: string;
  user_id: string;
  address: Address;
  items: OrderItem[];
  status: OrderStatus;
  fulfillments?: Fulfillment[];
  payment_history: OrderPayment[];
  cancel_reason?: string;
  return_items?: string[];
  return_payment_method_id?: string;
  exchange_items?: string[];
  exchange_new_items?: string[];
  exchange_payment_method_id?: string;
  exchange_price_difference?: number;
}

export interface User {
  user_id: string;
  name: { first_name: string; last_name: string };
  address: Address;
  email: string;
  payment_methods: Record<string, PaymentMethod>;
  orders: string[];
}

export interface Store {
  products: Record<string, Product>;
  users: Record<string, User>;
  orders: Record<string, Order>;
}

// ─── Session state ───────────────────────────────────────────────────────────

export interface ActivityEntry {
  seq: number;
  tool: string;
  summary: string;
  at: number;
}

/** Capped in state, not just in the projection — an uncapped list would grow
 *  the pushed payload for the length of the call. */
export const MAX_ACTIVITY = 10;

export interface RetailState {
  store: Store;
  /** Set by the two finder tools. Null until the caller is identified. */
  authenticatedUserId: string | null;
  /** Monotonic. Every tool call increments it, which is what guarantees the
   *  projection differs and therefore gets pushed — `syncState` sends only
   *  when the projected result changed. */
  callSeq: number;
  activity: ActivityEntry[];
  focus: { orderId?: string; productId?: string };
}

export type StateSlot = { retail?: RetailState };

// ─── View types — exactly what crosses the wire ──────────────────────────────

export interface PaymentMethodView {
  id: string;
  source: PaymentMethod["source"];
  label: string;
  /** Gift cards only. */
  balance?: number;
}

export interface OrderItemView {
  name: string;
  itemId: string;
  options: Record<string, string>;
  price: number;
}

export interface OrderView {
  orderId: string;
  status: OrderStatus;
  total: number;
  items: OrderItemView[];
  address: Address;
}

export interface CustomerView {
  userId: string;
  name: string;
  email: string;
  address: Address;
  paymentMethods: PaymentMethodView[];
}

/** What else one item in the focused order could become. This is what makes an
 *  exchange sayable — without it "exchange the kettle" has no target. */
export interface SwapOptionView {
  itemId: string;
  itemName: string;
  currentOptions: Record<string, string>;
  alternatives: { itemId: string; options: Record<string, string>; price: number }[];
}

export interface StoreView {
  customer: CustomerView | null;
  orders: OrderView[];
  focus: { orderId?: string; productId?: string };
  /** Populated only for the focused order. */
  swapOptions: SwapOptionView[];
  callSeq: number;
  activity: ActivityEntry[];
  scriptBullets: string[];
  productCount: number;
}

export const MAX_SWAP_ITEMS = 3;
export const MAX_SWAP_ALTERNATIVES = 4;

// ─── Demo personas ───────────────────────────────────────────────────────────

export interface DemoPersona {
  name: string;
  email: string;
  zip: string;
  /** The one interesting thing about this customer, so a user can pick the path
   *  they want to exercise instead of guessing. */
  hint: string;
}

/**
 * The character-select screen. A first-time user has no email to give, so
 * without this the agent cannot be driven at all.
 *
 * A CONSTANT, not a projection of `store.users`: reading it out of the store
 * would put five unauthenticated customers' emails into the projection, which
 * is the one thing `storeView` exists to prevent. The duplication with
 * `seed.json` is deliberate and `shared.test.ts` pins the two together.
 */
export const DEMO_PERSONAS: readonly DemoPersona[] = [
  {
    name: "Emma Smith",
    email: "emma.smith3991@example.com",
    zip: "10192",
    hint: "Simplest path — single-item orders, $62.00 gift card.",
  },
  {
    name: "Olivia Ito",
    email: "olivia.ito5204@example.com",
    zip: "80218",
    hint: "Three pending orders, all three payment types. Try switching an order's payment method.",
  },
  {
    name: "Aarav Anderson",
    email: "aarav.anderson9752@example.com",
    zip: "19031",
    hint: "One gift card holding $17.00. A pricier exchange gets refused; one order has the same kettle twice.",
  },
  {
    name: "Anya Garcia",
    email: "anya.garcia2061@example.com",
    zip: "19036",
    hint: "$51.00 gift card — upgrading the laptop in her pending order costs more than it holds.",
  },
  {
    name: "Harper Brown",
    email: "harper.brown3965@example.com",
    zip: "76112",
    hint: "No gift card, so a refund can only go back to PayPal.",
  },
  {
    name: "Aarav Gonzalez",
    email: "aarav.gonzalez9269@example.com",
    zip: "78268",
    hint: "Shares a first name with Aarav Anderson — the zip is what tells them apart.",
  },
] as const;

// ─── Projection ──────────────────────────────────────────────────────────────

function paymentLabel(method: PaymentMethod): string {
  if (method.source === "gift_card") return "Gift card";
  if (method.source === "paypal") return "PayPal";
  return `${method.brand} ending ${method.last_four}`;
}

function paymentMethodView(method: PaymentMethod): PaymentMethodView {
  return {
    id: method.id,
    source: method.source,
    label: paymentLabel(method),
    ...(method.source === "gift_card" ? { balance: method.balance } : {}),
  };
}

/** Net of payments minus refunds — what the customer has actually paid. Items
 *  can't be summed instead: a modified order's items no longer match what was
 *  charged. */
export function orderTotal(order: Order): number {
  const net = order.payment_history.reduce(
    (sum, p) => sum + (p.transaction_type === "payment" ? p.amount : -p.amount),
    0,
  );
  return Math.round(net * 100) / 100;
}

function orderView(order: Order): OrderView {
  return {
    orderId: order.order_id,
    status: order.status,
    total: orderTotal(order),
    address: order.address,
    items: order.items.map((i) => ({
      name: i.name,
      itemId: i.item_id,
      options: i.options,
      price: i.price,
    })),
  };
}

/**
 * What else each item in the focused order could become — the data that makes
 * an exchange sayable. Only available variants, only the focused order, and
 * capped on both axes so the payload stays bounded.
 */
function swapOptionsFor(state: RetailState, order: Order | undefined): SwapOptionView[] {
  if (!order) return [];
  return order.items.slice(0, MAX_SWAP_ITEMS).map((item) => {
    const product = state.store.products[item.product_id];
    const alternatives = Object.values(product?.variants ?? {})
      .filter((variant) => variant.available && variant.item_id !== item.item_id)
      .sort((a, b) => Math.abs(a.price - item.price) - Math.abs(b.price - item.price))
      .slice(0, MAX_SWAP_ALTERNATIVES)
      .map((variant) => ({
        itemId: variant.item_id,
        options: variant.options,
        price: variant.price,
      }));
    return {
      itemId: item.item_id,
      itemName: item.name,
      currentOptions: item.options,
      alternatives,
    };
  });
}

/** The `syncState` projection — the entire contract with `client.tsx`.
 *
 *  Only the authenticated customer is projected. The other five seeded
 *  customers' emails, addresses, and payment methods never leave the server,
 *  which is why `syncState` takes a projection rather than a boolean. */
export function storeView(slot: StateSlot): StoreView {
  const state = slot.retail;
  const userId = state?.authenticatedUserId ?? null;
  const user = userId ? state?.store.users[userId] : undefined;
  const focusedOrderId = state?.focus.orderId;
  // Gated on `user`: an order is only ever projected for the customer on the
  // call, so a stale focus from before authentication cannot leak one.
  const focusedOrder =
    state && user && focusedOrderId && user.orders.includes(focusedOrderId)
      ? state.store.orders[focusedOrderId]
      : undefined;

  return {
    customer: user
      ? {
          userId: user.user_id,
          name: `${user.name.first_name} ${user.name.last_name}`,
          email: user.email,
          address: user.address,
          paymentMethods: Object.values(user.payment_methods).map(paymentMethodView),
        }
      : null,
    orders: user
      ? user.orders
          .map((id) => state?.store.orders[id])
          .filter((o): o is Order => o !== undefined)
          .map(orderView)
      : [],
    // The orderId half is gated the same way `focusedOrder` is above: a focus
    // left over from another customer's session (or from before
    // authentication) must not surface that order's id in the view, even
    // though its details were already withheld from `orders`/`swapOptions`.
    focus: {
      ...(focusedOrder && focusedOrderId ? { orderId: focusedOrderId } : {}),
      ...(state?.focus.productId ? { productId: state.focus.productId } : {}),
    },
    swapOptions: state ? swapOptionsFor(state, focusedOrder) : [],
    callSeq: state?.callSeq ?? 0,
    activity: state?.activity.slice(-MAX_ACTIVITY) ?? [],
    scriptBullets: buildScriptBullets(state),
    productCount: Object.keys(state?.store.products ?? {}).length,
  };
}

// ─── Script bullets ──────────────────────────────────────────────────────────

const MAX_BULLETS = 6;

/**
 * Generated from the caller's own orders, not a fixed list. A capability list
 * that offers actions the data can't support — "return an item" to someone
 * with no delivered order — is worse than no list.
 */
export function buildScriptBullets(state: RetailState | undefined): string[] {
  const userId = state?.authenticatedUserId;
  const user = userId ? state?.store.users[userId] : undefined;

  // Pre-auth: only the two ways in. The personas panel (a constant, rendered
  // straight from DEMO_PERSONAS) covers WHICH customer to be.
  if (!(state && user)) {
    const first = DEMO_PERSONAS[0];
    return [
      `"My email is ${first?.email ?? ""}"`,
      `"I'm ${first?.name ?? ""}, zip ${first?.zip ?? ""}"`,
    ];
  }

  const orders = user.orders
    .map((id) => state.store.orders[id])
    .filter((o): o is Order => o !== undefined);
  const pending = orders.filter((o) => o.status === "pending");
  const delivered = orders.filter((o) => o.status === "delivered");

  const bullets: string[] = [];

  if (pending.length === 1) {
    bullets.push('"Cancel my pending order"');
  } else if (pending.length > 1) {
    bullets.push(`"Cancel my first pending order" (${pending.length} pending)`);
  }
  if (pending.length > 0) {
    bullets.push('"Change the shipping address on my pending order"');
  }
  if (pending.length > 0 && Object.keys(user.payment_methods).length > 1) {
    bullets.push('"Switch that order to my other payment method"');
  }

  const deliveredItem = delivered[0]?.items[0];
  if (deliveredItem) {
    bullets.push(`"Return the ${deliveredItem.name}"`);
    // Name a real alternative option. "Exchange it for a different option" is
    // not something a caller can act on — they need words to say.
    const alternative = Object.values(
      state.store.products[deliveredItem.product_id]?.variants ?? {},
    ).find((variant) => variant.available && variant.item_id !== deliveredItem.item_id);
    bullets.push(
      alternative
        ? `"Exchange the ${deliveredItem.name} for the ${Object.values(alternative.options).join(" ")} one"`
        : `"Exchange the ${deliveredItem.name}"`,
    );
  }

  bullets.push('"Update my default address"');

  return bullets.slice(0, MAX_BULLETS);
}
