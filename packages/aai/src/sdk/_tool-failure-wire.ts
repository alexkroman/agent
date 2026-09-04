// Copyright 2026 the AAI authors. MIT license.
/**
 * The wire form of a tool failure — the host's half of the pair whose author
 * half (`toolFailure` / `isToolFailure`) lives in `sdk/utils.ts`.
 *
 * An `_`-internal module rather than one more export of `sdk/utils.ts`, because
 * that module IS the `@alexkroman1/aai/utils` subpath: anything on it is
 * importable by an agent author and sits in their autocomplete, which an
 * `@internal` tag documents but does not prevent. Every reader of this one is
 * inside `host/`, so a private module is what it actually needs — and
 * `check:api-contracts` refuses a NEW `@internal` name on a public subpath for
 * exactly that reason.
 */

/**
 * The PRE-SERIALIZED wire form of a {@link ToolFailure}: the JSON string
 * `'{"error":"<message>"}'`, which is what the host emits for a tool that threw
 * or could not be dispatched at all.
 *
 * @remarks
 * Not for tool authors — return {@link toolFailure} (or the bare
 * `{ error: message }` object) from `execute` instead, so the value stays
 * inspectable by the tool's own callers and its tests. `isToolFailure` does NOT
 * narrow this function's string result, which is the whole reason the two have
 * names that no longer look interchangeable: this was `toolError`, one letter of
 * intuition away from reading as the constructor for the thing `isToolFailure`
 * tests, and it was used by zero of the fourteen shipped templates despite its
 * own doc pointing authors at it.
 *
 * @internal
 */
export function serializeToolFailure(message: string): string {
  return JSON.stringify({ error: message });
}
