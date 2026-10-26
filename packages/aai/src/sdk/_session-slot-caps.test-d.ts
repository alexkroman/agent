// Copyright 2026 the AAI authors. MIT license.
/**
 * Type-level contract of `SlotCaps`: only a key whose value is an array (or an
 * array behind `null`/`undefined`) may carry a cap, and a cap is optional.
 * `_session-slot-caps.test.ts` used to hold this as two suppressed
 * lines; a claim about what does NOT compile belongs here, where it is stated
 * positively and counted by nothing.
 */
import { expectTypeOf, test } from "vitest";
import type { DeepReadonly } from "./deep-readonly.ts";
import { sessionSlot } from "./session-slot.ts";
import type { SlotDraftOf, SlotValueOf } from "./session-slot-handle.ts";
import type { SessionSlotOptions, SlotCaps } from "./session-slot-types.ts";

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

test("SlotValueOf is the frozen value and SlotDraftOf the mutable one, read off the handle", () => {
  const desk = sessionSlot("desk", (): Desk => ({ log: [], findings: [], open: null, count: 0 }));
  expectTypeOf<SlotValueOf<typeof desk>>().toEqualTypeOf<DeepReadonly<Desk>>();
  expectTypeOf<SlotDraftOf<typeof desk>>().toEqualTypeOf<Desk>();
  // A plain-value default types the slot by the value.
  const plain = sessionSlot("plain", { n: 0 });
  expectTypeOf<SlotDraftOf<typeof plain>>().toEqualTypeOf<{ n: number }>();
  // An inline `view` needs no annotation — its parameter is the frozen value
  // already — and a helper written AFTER the slot names it with `SlotValueOf`.
  const viewed = sessionSlot(
    "viewed",
    (): Desk => ({ log: [], findings: [], open: null, count: 0 }),
    {
      view: (desk) => {
        expectTypeOf(desk).toEqualTypeOf<DeepReadonly<Desk>>();
        return { count: desk.count };
      },
    },
  );
  const summarize = (desk: SlotValueOf<typeof viewed>): number => desk.log.length;
  expectTypeOf(summarize).parameter(0).toEqualTypeOf<DeepReadonly<Desk>>();
});

test("the session-slot options admit `sync`, `empty` and a hooked default", () => {
  expectTypeOf<SessionSlotOptions<Desk>["sync"]>().toEqualTypeOf<boolean | undefined>();
  expectTypeOf<SessionSlotOptions<Desk>["empty"]>().toEqualTypeOf<(() => Desk) | undefined>();
});
