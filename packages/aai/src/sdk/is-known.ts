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
