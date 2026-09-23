// Copyright 2026 the AAI authors. MIT license.
/**
 * Capability contract: `auth`.
 *
 * Who may open a session on a server: the opaque handle `createSessionAuth`
 * builds (what a server's `auth` option takes), the short-lived session ticket
 * a backend mints and a server verifies, the subprotocol it travels under, the
 * env variable that turns the built-in check on, and the close code a refusal
 * ends with.
 *
 * Its own capability rather than part of `server`: the promise is the TICKET —
 * its shape, lifetime and refusal — which moves independently of how a server
 * is assembled. `server`'s options reach `SessionAuth` by name only.
 *
 * Re-exported from `@alexkroman1/aai-runtime/auth`. This file is not shipped and
 * nothing imports it — it exists so `pnpm check:api-contracts` can extract a
 * report for this capability alone, hash it, and hold it to a committed epoch.
 * See `scripts/api-contracts.mjs`.
 */

export {
  createSessionAuth,
  createSessionToken,
  SESSION_AUTH_PROTOCOL_PREFIX,
  SESSION_SECRET_ENV,
  SESSION_UNAUTHORIZED_CLOSE_CODE,
  type SessionAuth,
  type SessionAuthOptions,
  type SessionIdentity,
  type SessionTokenInput,
  type SessionVerifier,
  type sessionAuthBrand,
  type VerifySessionTokenOptions,
  verifySessionToken,
} from "../../auth-barrel.ts";
