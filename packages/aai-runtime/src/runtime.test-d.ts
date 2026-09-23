// Copyright 2026 the AAI authors. MIT license.
/**
 * Type-level contract for the `Runtime` seal: only `createRuntime` mints one.
 *
 * `runtimeBrand` is a type-only `unique symbol`, so there is no value a caller
 * could write to satisfy it — which is the whole mechanism, and the one thing a
 * runtime spec cannot observe. A hand-written object with every OTHER member is
 * still not a `Runtime`.
 */

import { expectTypeOf, test } from "vitest";
import type { Runtime, runtimeBrand } from "./runtime.ts";

test("every member but the brand is not a Runtime", () => {
  expectTypeOf<Omit<Runtime, typeof runtimeBrand>>().not.toExtend<Runtime>();
  // …while a Runtime is still usable wherever the unbranded shape is asked for.
  expectTypeOf<Runtime>().toExtend<Omit<Runtime, typeof runtimeBrand>>();
});
