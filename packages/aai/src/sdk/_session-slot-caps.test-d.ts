// Copyright 2026 the AAI authors. MIT license.
/**
 * Type-level contract of `SlotCaps`: only a key whose value is an array (or an
 * array behind `null`/`undefined`) may carry a cap, and a cap is optional.
 * `_session-slot-caps.test.ts` used to hold this as two suppressed
 * lines; a claim about what does NOT compile belongs here, where it is stated
 * positively and counted by nothing.
 */
import { expectTypeOf, test } from "vitest";
import type { SlotCaps } from "./session-slot-types.ts";

type Desk = { log: string[]; findings: readonly string[]; open: string | null; count: number };

test("SlotCaps admits exactly the array-valued keys, each optional", () => {
  expectTypeOf<keyof SlotCaps<Desk>>().toEqualTypeOf<"log" | "findings">();
  expectTypeOf<SlotCaps<Desk>>().toEqualTypeOf<{
    readonly log?: number;
    readonly findings?: number;
  }>();
});

test("an array behind null is cappable; a primitive slot value has no caps at all", () => {
  expectTypeOf<keyof SlotCaps<{ log: string[] | null }>>().toEqualTypeOf<"log">();
  expectTypeOf<SlotCaps<number>>().toEqualTypeOf<never>();
});
