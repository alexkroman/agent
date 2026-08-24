/**
 * Addresses: the shared schema fields, and the two address changes as
 * plan/apply pairs (see `cancel.ts` for why every mutating action is split
 * that way).
 */

import { isToolFailure, type ToolFailure } from "@alexkroman1/aai";
import { z } from "zod";
import { resolveOrder } from "./resolve.ts";
import type { Address, RetailState } from "./shared.ts";
import { requireOwnUser } from "./store.ts";

/** Spread into both address tools' schemas. Two hand-copied zod shapes is how
 *  the order address and the profile address drift apart. */
export const AddressFields = {
  address1: z.string().max(200).describe("First line, e.g. '123 Main St'"),
  address2: z.string().max(200).describe("Second line, e.g. 'Apt 1' — pass '' if there is none"),
  city: z.string().max(100).describe("City, e.g. 'San Francisco'"),
  state: z.string().max(60).describe("State, e.g. 'CA'"),
  country: z.string().max(60).describe("Country, e.g. 'USA'"),
  zip: z.string().max(20).describe("Zip code, e.g. '12345'"),
};

export function toAddress(args: Address): Address {
  return {
    address1: args.address1,
    address2: args.address2,
    city: args.city,
    state: args.state,
    country: args.country,
    zip: args.zip,
  };
}

export function formatAddress(address: Address): string {
  const lines = [address.address1, address.address2].filter(Boolean).join(", ");
  return `${lines}, ${address.city} ${address.state} ${address.zip}, ${address.country}`;
}

// ─── One order's shipping address ────────────────────────────────────────────

export interface OrderAddressPlan {
  readBack: string;
  orderId: string;
  address: Address;
}

export function planOrderAddress(
  state: RetailState,
  spokenOrderId: string,
  address: Address,
): OrderAddressPlan | ToolFailure {
  const order = resolveOrder(state, spokenOrderId);
  if (isToolFailure(order)) return order;

  // Any pending variant is fine here — unlike cancel and modify-items, which
  // require exactly 'pending'. Re-addressing a modified order is harmless.
  if (!order.status.startsWith("pending")) {
    return {
      error: `Order ${order.order_id} is ${order.status}, and only a pending order's address can be changed.`,
    };
  }

  return {
    readBack: `ship order ${order.order_id} to ${formatAddress(address)} instead`,
    orderId: order.order_id,
    address: toAddress(address),
  };
}

export function applyOrderAddress(state: RetailState, plan: OrderAddressPlan) {
  const order = state.store.orders[plan.orderId];
  if (order) order.address = plan.address;
  return {
    order_id: plan.orderId,
    status: order?.status ?? "pending",
    address: plan.address,
    message: `Order ${plan.orderId} now ships to ${formatAddress(plan.address)}.`,
  };
}

// ─── The customer's default address ──────────────────────────────────────────

export interface UserAddressPlan {
  readBack: string;
  userId: string;
  address: Address;
}

export function planUserAddress(
  state: RetailState,
  userId: string,
  address: Address,
): UserAddressPlan | ToolFailure {
  const user = requireOwnUser(state, userId);
  if (isToolFailure(user)) return user;

  return {
    readBack:
      `change your default address for future orders to ${formatAddress(address)} ` +
      "(existing orders keep their own)",
    userId: user.user_id,
    address: toAddress(address),
  };
}

export function applyUserAddress(state: RetailState, plan: UserAddressPlan) {
  const user = state.store.users[plan.userId];
  if (user) user.address = plan.address;
  return {
    user_id: plan.userId,
    address: plan.address,
    message: `Default address updated to ${formatAddress(plan.address)}. Existing orders keep their own shipping addresses.`,
  };
}
