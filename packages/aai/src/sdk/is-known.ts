// Copyright 2026 the AAI authors. MIT license.
/**
 * `isKnown` — membership in a closed list, narrowed to the list's union.
 *
 * Every "known X" check in this package reads the same way: an OPEN type
 * (`TurnDetectionMode`, `VoicePresetName`, `LlmProviderName`) whose autocomplete
 * half is a `const` tuple, and a config value that is only a `string`. The
 * tuple's `.includes` takes the tuple's element type, so each site paid for the
 * check with a widening cast (`(LIST as readonly string[]).includes(v)`) — and
 * a cast of the LIST narrows nothing about the VALUE, which is the half the
 * caller needed.
 *
 * @module is-known
 */

/**
 * Whether `value` is one of `list`, narrowed to that list's element type.
 */
export function isKnown<T extends string>(list: readonly T[], value: string): value is T {
  // `some` with a string comparison rather than `includes`, whose parameter is
  // `T` — calling it with a `string` is the cast this helper exists to remove.
  return list.some((entry) => entry === value);
}

/**
 * The LITERAL members of an open union — `KnownLiterals<"a" | "b" | (string & {})>`
 * is `"a" | "b"`.
 *
 * A published vocabulary spells its literals INLINE in the open type
 * (`AssemblyAIGatewayModel`, `LlmProviderName`) rather than naming a closed
 * `Known*` union beside it: a closed union an author can import is a promise
 * that adding a member breaks, and the open one is not. Code that needs the
 * closed half — a `satisfies Record<…>` that must stay total — derives it here
 * rather than keeping a second copy of the list.
 *
 * `string extends T` holds only for the `string & {}` member (or a bare
 * `string`), so exactly the literals survive the distribution.
 */
export type KnownLiterals<T extends string> = T extends unknown
  ? string extends T
    ? never
    : T
  : never;
