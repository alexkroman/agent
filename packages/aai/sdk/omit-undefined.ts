// Copyright 2026 the AAI authors. MIT license.
/**
 * The one way to build the optional half of an object under
 * `exactOptionalPropertyTypes`.
 *
 * That flag draws a distinction most code wants and no literal can express:
 * `{ name?: string }` means *absent or a string*, never present-and-undefined.
 * So `{ name: maybeName }` is a type error whenever `maybeName` can be
 * `undefined`, and the only spelling that compiles is a conditional spread:
 *
 * ```ts no-check
 * ...(name !== undefined ? { name } : {}),
 * ...(greeting !== undefined ? { greeting } : {}),
 * ```
 *
 * Which is correct, and was written by hand 44 times across five packages —
 * eight of them in one object literal. Each line names its key twice, and the
 * shape is dense enough that a mismatched pair (`x !== undefined ? { y: x }`)
 * reads as ordinary noise rather than as the bug it is.
 *
 * @module omit-undefined
 */

/**
 * Drop the `undefined`-valued entries of `obj`, typing every surviving key as
 * optional-and-defined — exactly what `exactOptionalPropertyTypes` wants on
 * the receiving end.
 *
 * Spread the result into the literal it belongs to; the keys are the object's
 * own, so renaming one (`{ leadMs: audioLeadMs }`) works the same as passing
 * shorthand.
 *
 * "Removed" means `undefined` and nothing else, so a `null` survives — a null
 * value is a value; only `undefined` is an absence here. The `unknown extends`
 * branch in the return type is written inline rather than named, so the one
 * new symbol on the published surface is this function; what it says is that
 * `Exclude<unknown, undefined>` is still `unknown`, which a field declared
 * `body?: unknown` (the CLI's API client has one) then cannot hand to anything
 * with a narrower parameter. `NonNullable<unknown> | null` is what "unknown,
 * but not undefined" means, and it is what the `!== undefined` narrowing this
 * replaces already produced. The check catches `any` too, which lands in the
 * same place.
 *
 * @example
 * ```ts
 * import { omitUndefined } from "@alexkroman1/aai/utils";
 *
 * declare const name: string | undefined;
 * declare const greeting: string | undefined;
 *
 * const config: { slug: string; name?: string; greeting?: string } = {
 *   slug: "demo",
 *   ...omitUndefined({ name, greeting }),
 * };
 * ```
 */
export function omitUndefined<T extends object>(
  obj: T,
): {
  [K in keyof T]?: unknown extends T[K] ? NonNullable<unknown> | null : Exclude<T[K], undefined>;
} {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj) as [string, unknown][]) {
    if (value !== undefined) out[key] = value;
  }
  return out as {
    [K in keyof T]?: unknown extends T[K] ? NonNullable<unknown> | null : Exclude<T[K], undefined>;
  };
}
