// Copyright 2026 the AAI authors. MIT license.
/**
 * The sandbox backends' one shared failure class.
 *
 * A spawn that fails is never the caller's fault and is almost always
 * transient — Modal had no capacity in time, the scheduler took longer than
 * `tunnels()` waits, the guest died during boot. The agent path already said
 * so (`brokerSessionUrl` answers a retryable 503 for any spawn failure), but
 * the STUDIO path had no such taxonomy: a spawn failure reached the shared
 * Hono handler as a bare `Error`, which logged it as `Unhandled error on
 * /studio/projects/<x>/session` and answered an opaque
 * `500 Internal server error`. Both halves of that are wrong — the platform
 * is not broken, and the browser cannot tell "retry in a moment" from "this
 * project is broken forever".
 *
 * A marker class rather than a curated message: the message stays the
 * technical one the backend built (it is what lands in the log, `cause`
 * chain included), and the sentence sent to the client is authored once in
 * `error-handler.ts`. Keeping the two apart is what lets the log stay
 * specific without the wire body leaking internals.
 *
 * Lives in its own module so `error-handler.ts` — imported by every app —
 * can classify without pulling in the Modal SDK.
 */
export class SandboxUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SandboxUnavailableError";
  }
}
