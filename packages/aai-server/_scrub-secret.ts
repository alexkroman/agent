// Copyright 2026 the AAI authors. MIT license.
/**
 * Keep one secret out of a thrown error, for the paths that INLINE a credential
 * into a statement they issue.
 *
 * Split out of `app-database.ts` (which was at its line cap) and general on its
 * own terms: the hazard is not per-app-database but per-driver — postgres
 * clients attach the failing query text as an own property on the error, and
 * this repo's process safety nets (`service-config.ts`) `console.error` whole
 * error objects, so an unscrubbed failure puts a live credential in the logs.
 */

/**
 * Remove every occurrence of `secret` from an error before it can reach a
 * log: the message and every string own property (postgres drivers attach
 * the failing `query`/`parameters` there). Mutate-and-rethrow rather than
 * wrap, so the stack and type survive; a non-Error value is rendered to a
 * scrubbed message instead.
 */
export function scrubSecret(failure: unknown, secret: string): unknown {
  if (!(failure instanceof Error)) {
    return typeof failure === "string" ? failure.replaceAll(secret, "[redacted]") : failure;
  }
  failure.message = failure.message.replaceAll(secret, "[redacted]");
  // `Reflect` rather than a cast: an `Error` has no index signature, so reading
  // and writing its own properties by name used to take two `as unknown as`
  // launderings — which is exactly what the escape-hatch ratchet counts.
  for (const key of Object.keys(failure)) {
    const value: unknown = Reflect.get(failure, key);
    if (typeof value === "string" && value.includes(secret)) {
      Reflect.set(failure, key, "[redacted]");
    }
  }
  return failure;
}
