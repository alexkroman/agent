// Copyright 2026 the AAI authors. MIT license.
/**
 * Type-level spec for a SLOT tool's dialog gate — the half of the gate that
 * `dialog.test-d.ts` cannot stand under, because there `E` is fixed by the
 * handle and here it is a type parameter of the same call.
 *
 * The function-form `sendFrom: () => ({ type: "QUOTED" })` compiled on
 * `dialog.tool` and not on `slot.tool`/`slot.updateTool`, where it needed an
 * `as const`, and the error named `dialog` rather than `sendFrom`. A runtime
 * test runs the `as const` version happily; only this file sees the
 * difference. The misuse pins are type RELATIONS (a def not assignable to the
 * overload's parameter), never a suppressed error, which passes on any error.
 */
import { expectTypeOf, test } from "vitest";
import { dialog } from "./dialog.ts";
import type {
  DialogSendFromGuard,
  DialogSendFromMisuse,
  DialogToolResult,
} from "./dialog-types.ts";
import type { ToolInputSchema } from "./schema.ts";
import { sessionSlot } from "./session-slot.ts";
import type { UngatedDef } from "./session-slot-handle.ts";
import type { SlotDialogGate, SlotUpdateToolDef } from "./session-slot-types.ts";
import type { InferToolOutput } from "./types.ts";
import type { ToolFailure } from "./utils.ts";

type Cart = { items: string[]; quote: number | null };
const cartSlot = sessionSlot("cart", (): Cart => ({ items: [], quote: null }));
const checkout = dialog("checkout", {
  initial: "shopping",
  states: {
    shopping: { on: { QUOTED: "paying" } },
    paying: { on: { PAID: "done", BACK: "shopping" } },
    done: { final: true },
  },
});
type Ev = { type: "QUOTED" } | { type: "PAID" } | { type: "BACK" };

test("a function-form sendFrom returning a plain literal narrows on slot.tool, as on dialog.tool", () => {
  const bare = cartSlot.tool({
    description: "Count, then quote",
    dialog: checkout,
    execute: (_args, cart) => ({ n: cart.items.length }),
    sendFrom: () => ({ type: "QUOTED" }),
  });
  expectTypeOf<InferToolOutput<typeof bare>>().toEqualTypeOf<
    DialogToolResult<{ n: number }> | ToolFailure
  >();
  const gated = cartSlot.tool({
    description: "Count, gated",
    dialog: checkout,
    when: "shopping",
    execute: (_args, cart) => ({ n: cart.items.length }),
    sendFrom: (result) => {
      expectTypeOf(result).toEqualTypeOf<{ n: number }>();
      return result.n > 0 ? { type: "QUOTED" } : undefined;
    },
  });
  expectTypeOf<InferToolOutput<typeof gated>>().toEqualTypeOf<
    DialogToolResult<{ n: number }> | ToolFailure
  >();
});

test("…and on slot.updateTool, with `when`, with `prepare`, with `report`", () => {
  const withWhen = cartSlot.updateTool({
    description: "Quote",
    dialog: checkout,
    when: "shopping",
    execute: (_args, cart) => ({ quote: cart.quote, go: true }),
    sendFrom: (result) => (result.go ? { type: "QUOTED" } : undefined),
  });
  expectTypeOf<InferToolOutput<typeof withWhen>>().toEqualTypeOf<
    DialogToolResult<{ quote: number | null; go: boolean }> | ToolFailure
  >();
  cartSlot.updateTool({
    description: "Quote, prepared",
    dialog: checkout,
    when: "shopping",
    prepare: async (_args, cart) => cart.items.length,
    execute: (_args, cart, n) => ({ quote: cart.quote, n, go: true }),
    sendFrom: (result) => {
      expectTypeOf(result).toEqualTypeOf<{ quote: number | null; n: number; go: boolean }>();
      return result.go ? { type: "QUOTED" } : undefined;
    },
  });
  cartSlot.updateTool({
    description: "Quote, reported",
    dialog: checkout,
    execute: (_args, cart) => ({ quote: cart.quote, go: true }),
    report: (stored, partial) => ({ ...partial, count: stored.items.length }),
    sendFrom: (result) => {
      expectTypeOf(result).toEqualTypeOf<{ quote: number | null; go: boolean; count: number }>();
      return result.count > 0 ? { type: "PAID" } : { type: "BACK" };
    },
  });
});

test("an event the dialog does not declare is still refused, in both forms", () => {
  type ToolGate = Parameters<typeof cartSlot.tool<ToolInputSchema, { n: number }, Ev, string>>[0];
  // Six type arguments select the prepared+gated overload alone; the gated
  // one without `prepare` shares its gate type, spelled below for the field pin.
  type UpdateGate = Parameters<
    typeof cartSlot.updateTool<ToolInputSchema, number, { n: number }, { n: number }, Ev, string>
  >[0];
  expectTypeOf<{ type: "QUOTED" }>().toExtend<NonNullable<ToolGate["send"]>>();
  expectTypeOf<{ type: "TYPO" }>().not.toExtend<NonNullable<ToolGate["send"]>>();
  expectTypeOf<{ type: "TYPO" }>().not.toExtend<NonNullable<UpdateGate["send"]>>();
  // The function form's return: the intersection is `E` once `E` is known.
  expectTypeOf<() => { type: "QUOTED" }>().toExtend<NonNullable<ToolGate["sendFrom"]>>();
  expectTypeOf<() => { type: "TYPO" }>().not.toExtend<NonNullable<ToolGate["sendFrom"]>>();
  expectTypeOf<() => { type: "TYPO" }>().not.toExtend<NonNullable<UpdateGate["sendFrom"]>>();
  // A payload an event declares is still required of the literal.
  type Paid = { type: "PAID"; amount: number };
  type PaidGate = Parameters<typeof cartSlot.tool<ToolInputSchema, { n: number }, Paid, string>>[0];
  expectTypeOf<() => { type: "PAID"; amount: number }>().toExtend<
    NonNullable<PaidGate["sendFrom"]>
  >();
  expectTypeOf<() => { type: "PAID" }>().not.toExtend<NonNullable<PaidGate["sendFrom"]>>();
});

test("a field-name sendFrom naming a field that holds no event fails the CALL", () => {
  type Out = { count: number; next?: "QUOTED" };
  type ToolDef<K extends string> = Parameters<typeof cartSlot.tool<ToolInputSchema, Out, Ev, K>>[0];
  type PreparedDef<K extends string> = Parameters<
    typeof cartSlot.updateTool<ToolInputSchema, number, Out, Out, Ev, K>
  >[0];
  // The gated overload without `prepare`, as `SessionSlot.updateTool` spells it.
  type UpdateDef<K extends string> = SlotUpdateToolDef<ToolInputSchema, Cart, Out, Out> &
    SlotDialogGate<Out, Ev, K> &
    NoInfer<DialogSendFromGuard<K, Awaited<Out>, Ev>>;
  type Def<K extends string> = {
    description: string;
    dialog: typeof checkout;
    sendFrom: K;
    execute: () => Out;
  };
  type Prepared<K extends string> = Omit<Def<K>, "execute"> & {
    prepare: () => number;
    execute: (_args: unknown, _draft: Cart, _n: number) => Out;
  };
  expectTypeOf<Def<"next">>().toExtend<ToolDef<"next">>();
  expectTypeOf<Def<"next">>().toExtend<UpdateDef<"next">>();
  expectTypeOf<Prepared<"next">>().toExtend<PreparedDef<"next">>();
  expectTypeOf<ToolDef<"count">>().not.toBeNever();
  expectTypeOf<UpdateDef<"count">>().not.toBeNever();
  expectTypeOf<PreparedDef<"count">>().not.toBeNever();
  expectTypeOf<Def<"count">>().not.toExtend<ToolDef<"count">>();
  expectTypeOf<Def<"count">>().not.toExtend<UpdateDef<"count">>();
  expectTypeOf<Prepared<"count">>().not.toExtend<PreparedDef<"count">>();
  // What the refusal says: the misuse type, naming the field that would work.
  expectTypeOf<DialogSendFromGuard<"count", Out, Ev>>().toEqualTypeOf<{
    sendFrom: DialogSendFromMisuse<"count", "next">;
  }>();
});

test("the ungated overloads refuse a def carrying a dialog, with the rule as the message", () => {
  type Plain = Parameters<typeof cartSlot.tool<ToolInputSchema, { n: number }>>[0];
  expectTypeOf<Plain>().toExtend<UngatedDef>();
  expectTypeOf<{
    description: string;
    dialog: typeof checkout;
    execute: () => 1;
  }>().not.toExtend<UngatedDef>();
});
