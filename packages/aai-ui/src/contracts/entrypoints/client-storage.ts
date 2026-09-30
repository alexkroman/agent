// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `client-storage`.
 *
 * What a page remembers in this browser and hands the session: a stored string
 * (`createStoredValue`, `useStoredValue`), the linked client id
 * (`createLinkedClient`, over `browserClientId`), and the phone number in the
 * E.164 form the session's `phone` must carry (`phoneE164`).
 *
 * Re-exported from `@alexkroman1/aai-ui`. This file is not shipped and nothing
 * imports it — it exists so `pnpm check:api-contracts` can extract a report for
 * this capability alone, hash it, and hold it to a committed epoch. See
 * `scripts/api-contracts.mjs`.
 */

export {
  createLinkedClient,
  createStoredValue,
  type LinkedClient,
  type LinkedClientOptions,
  type PhoneE164Options,
  phoneE164,
  type StoredValue,
  type StoredValueOptions,
  useStoredValue,
} from "../../index.ts";
