import { z } from "zod";
import type { Address } from "./shared.ts";

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
