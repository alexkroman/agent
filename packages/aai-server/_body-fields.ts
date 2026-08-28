// Copyright 2026 the AAI authors. MIT license.
/**
 * Reading one field out of an untrusted JSON body, and answering 400 when it is
 * not what the route needs.
 *
 * The five guest-called platform routes each grew their own copy of these:
 * `requiredString` was byte-identical in three of them, and `requiredInt` /
 * `requiredSize` differed only in whether zero is a floor. That is the
 * concentration AGENTS.md calls a missing seam — the same reasoning restated until
 * one copy drifts, which is exactly what `guest-bearer.ts` was extracted to stop
 * one layer up.
 *
 * ## Why not zod, which this package already uses
 *
 * `schemas.ts` plus `zValidator("json", …)` is how every AUTHOR-facing body on this
 * surface is validated, and it would be the better answer for these too — it gives
 * the 400 messages for free and makes the accepted shape one declaration a reviewer
 * can read. It is deliberately not what this module is: these routes dispatch on a
 * `method` field and the required fields differ PER METHOD, so one schema per route
 * would have to be a discriminated union over the method — a bigger change than
 * de-duplicating the readers, and one worth making on its own rather than inside a
 * cleanup. Reach for a schema when a route's body stops being method-dependent.
 *
 * @internal
 */

import { HTTPException } from "hono/http-exception";

/** A required non-empty string field. */
export function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value === "") {
    throw new HTTPException(400, { message: `${key} is required` });
  }
  return value;
}

/** A required finite integer field, of either sign. */
export function requiredInt(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new HTTPException(400, { message: `${key} must be an integer` });
  }
  return value;
}

/**
 * A required integer field that cannot be negative.
 *
 * Separate from {@link requiredInt} rather than a flag, because the two carry
 * different MESSAGES and a caller reading a byte count wants the floor named: a
 * negative size makes a read ask for a window before the file starts.
 */
export function requiredSize(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new HTTPException(400, { message: `${key} must be a non-negative integer` });
  }
  return value;
}

/** An optional string field. Absent is fine; present and wrong is a 400. */
export function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new HTTPException(400, { message: `${key} must be a string` });
  }
  return value;
}

/**
 * Whether `value` is one of a closed tuple of method names.
 *
 * The cast is the one this narrowing needs: `readonly string[]`'s `includes` takes
 * a `string`, where the tuple's own takes only its members — so a caller cannot ask
 * it about an arbitrary string without it.
 */
export function isOneOf<const T extends readonly string[]>(
  methods: T,
  value: unknown,
): value is T[number] {
  return typeof value === "string" && (methods as readonly string[]).includes(value);
}
