// Copyright 2026 the AAI authors. MIT license.
/**
 * The two forms of `ClientTheme` are EXCLUSIVE at the type level.
 *
 * A mixed `{ primary, mode: "dark", bg }` used to compile: an object literal is
 * checked against the union as a whole, so a key from either member passed
 * excess-property checking, and at runtime `isPreset` won and `bg` was dropped
 * without a word. The `?: undefined` guards on each member are what make the
 * mixed literal a compile error, and this file is what keeps them there.
 *
 * Probed with a conditional rather than a suppression directive: an assignability
 * question answered as `true`/`false` names the shape that moved, where a
 * suppressed error passes on ANY error.
 */

import { expectTypeOf, test } from "vitest";
import type { ClientTheme, ClientThemePreset, ClientThemeTokens } from "./types.ts";

/** Whether `X` is a `ClientTheme` — i.e. whether `mountClient({ theme: x })` compiles. */
type ThemeAccepts<X> = [X] extends [ClientTheme] ? true : false;

test("each form on its own is a theme", () => {
  expectTypeOf<ThemeAccepts<{ primary: string; mode: "dark" }>>().toEqualTypeOf<true>();
  expectTypeOf<ThemeAccepts<{ primary: string; mode: "light" }>>().toEqualTypeOf<true>();
  expectTypeOf<ThemeAccepts<{ bg: string; primary: string; text: string }>>().toEqualTypeOf<true>();
  expectTypeOf<ThemeAccepts<Record<never, never>>>().toEqualTypeOf<true>();
  // `{ primary }` alone is both forms, and resolves alike.
  expectTypeOf<ThemeAccepts<{ primary: string }>>().toEqualTypeOf<true>();
  // The named members still fit the union they make up.
  expectTypeOf<ThemeAccepts<ClientThemeTokens>>().toEqualTypeOf<true>();
  expectTypeOf<ThemeAccepts<ClientThemePreset>>().toEqualTypeOf<true>();
});

test("a theme naming `mode` may name no token but `primary`, and vice versa", () => {
  // The mixed literal the runtime used to drop `bg` from.
  expectTypeOf<
    ThemeAccepts<{ primary: string; mode: "dark"; bg: string }>
  >().toEqualTypeOf<false>();
  expectTypeOf<ThemeAccepts<{ mode: "light"; surface: string }>>().toEqualTypeOf<false>();
  expectTypeOf<
    ThemeAccepts<{ primary: string; mode: "dark"; text: string; border: string }>
  >().toEqualTypeOf<false>();
});
