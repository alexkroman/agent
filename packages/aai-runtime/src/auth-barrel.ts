// Copyright 2026 the AAI authors. MIT license.
/**
 * `@alexkroman1/aai-runtime/auth` — who may open a session on a server.
 *
 * A self-hosted server's `WS /websocket` is open to anyone who can reach the
 * port unless it is gated. This subpath is the gate: {@link createSessionAuth}
 * builds the handle a server takes as `auth`, and {@link createSessionToken} /
 * {@link verifySessionToken} mint and check the short-lived ticket a browser
 * presents. Your own backend mints a ticket after its own login check; the
 * server verifies it at the upgrade, before the handshake completes.
 *
 * ```ts
 * import { createSessionToken } from "@alexkroman1/aai-runtime/auth";
 *
 * // In your own backend, after your own login check:
 * const token = createSessionToken({
 *   secret: process.env.AAI_SESSION_SECRET ?? "",
 *   sub: "user-42",
 * });
 * ```
 *
 * Its own subpath, and its own capability, rather than names on the root
 * barrel: an embedder who serves an agent on loopback never needs it, and the
 * promise it makes — a ticket's shape and lifetime, the close code a refusal
 * ends with — moves independently of how a server is built.
 *
 * Exports are enumerated explicitly (no `export *`) so the public surface is
 * deliberate.
 *
 * @module auth
 */

// The seal `SessionAuth` carries. TYPE-ONLY: there is no value to import.
export type { sessionAuthBrand } from "./session-auth.ts";
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
  type VerifySessionTokenOptions,
  verifySessionToken,
} from "./session-auth.ts";
