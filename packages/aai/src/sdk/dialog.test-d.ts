// Copyright 2026 the AAI authors. MIT license.
/**
 * Type-level spec for the things about a dialog's authoring surface that can
 * only fail SILENTLY.
 *
 * The first three used to compile while meaning nothing: `sendFrom`'s parameter
 * inferred as `unknown` when it was written above `execute`; a gated tool's
 * result type erased to `unknown` at the interface; and a spec's event names
 * unenforced. A runtime test cannot see any of the three — every one of them
 * runs correctly and reports the right values — so this file is the only thing
 * standing under them.
 *
 * Two more joined them with the session-event namespace. A `@` name left in the
 * author-facing event union is a dozen events nobody may send by hand sitting in
 * the autocomplete for the one they must, and everything still runs. And
 * `AnyDialog`'s erasure is load-bearing in one direction only: if a concrete
 * dialog stopped being assignable to it, `agent({ dialogs })` would reject every
 * dialog anyone has — which fails at a call site, but in the templates rather
 * than here.
 */
import { expectTypeOf, test } from "vitest";
import { setup } from "xstate";
import { z } from "zod";
import { dialog } from "./dialog.ts";
import type { AnyDialog } from "./dialog-handle.ts";
import type {
  DialogEvent,
  DialogSendFromMisuse,
  DialogSpec,
  DialogToolResult,
} from "./dialog-types.ts";
import type { ToolInputSchema } from "./schema.ts";
import type { SessionEvent } from "./session-event-map.ts";
import { sessionSlot } from "./session-slot.ts";
import type { SlotHolder } from "./session-state.ts";
import type { InferToolOutput, ToolDef } from "./types.ts";
import type { ToolFailure } from "./utils.ts";

const machine = setup({ types: {} as { events: { type: "QUOTED" } } }).createMachine({
  id: "claim",
  initial: "quoting",
  states: { quoting: {}, settled: { type: "final" } },
});

const claim = dialog("claim", machine);

/** A body whose declared return includes the failure arm — the ordinary case. */
const quoteBody = (): { premium: number } | ToolFailure => ({ premium: 500 });

test("sendFrom sees the SUCCESS type when execute is written above it", () => {
  claim.tool({
    description: "Quote the claim",
    when: "quoting",
    execute: quoteBody,
    sendFrom: (result) => {
      // `Exclude<…, ToolFailure>`: the failure check returns before `sendFrom`
      // runs, so a body declared `T | ToolFailure` narrows here for free.
      expectTypeOf(result).toEqualTypeOf<{ premium: number }>();
      return result.premium > 0 ? ({ type: "QUOTED" } as const) : undefined;
    },
  });
});

test("sendFrom sees the SAME type when it is written above execute", () => {
  // The whole point of `NoInfer<R>`. Without it `R` was inferred from whichever
  // of the two came first in the object literal, so THIS ordering silently gave
  // `result: unknown` — and still compiled, because everything is assignable to
  // a parameter of type `unknown` and nothing about the declaration looks wrong.
  claim.tool({
    description: "Quote the claim",
    when: "quoting",
    sendFrom: (result) => {
      expectTypeOf(result).toEqualTypeOf<{ premium: number }>();
      return result.premium > 0 ? ({ type: "QUOTED" } as const) : undefined;
    },
    execute: quoteBody,
  });
});

test("a dialog tool's declared output is the wrapped result, and it is still a ToolDef", () => {
  const quote = claim.tool({
    description: "Quote the claim",
    inputSchema: z.object({ excess: z.number() }),
    when: "quoting",
    send: { type: "QUOTED" },
    execute: ({ excess }) => ({ premium: excess * 2 }),
  });
  expectTypeOf<InferToolOutput<typeof quote>>().toEqualTypeOf<
    DialogToolResult<{ premium: number }> | ToolFailure
  >();
  // Narrowing a return type is covariant, so the agent's registry still takes it.
  expectTypeOf(quote).toExtend<ToolDef<ToolInputSchema>>();
});

const cart = sessionSlot("cart", () => ({ items: [] as string[] }));

test("a slot tool's declared output is the body's own, and it is still a ToolDef", () => {
  const count = cart.tool({
    description: "How many items",
    execute: (_args, value) => ({ count: value.items.length }),
  });
  const add = cart.updateTool({
    description: "Add an item",
    inputSchema: z.object({ item: z.string() }),
    execute: ({ item }, draft) => {
      draft.items.push(item);
      return { count: draft.items.length };
    },
  });
  expectTypeOf<InferToolOutput<typeof count>>().toEqualTypeOf<{ count: number }>();
  expectTypeOf<InferToolOutput<typeof add>>().toEqualTypeOf<{ count: number }>();
  expectTypeOf(count).toExtend<ToolDef<ToolInputSchema>>();
  expectTypeOf(add).toExtend<ToolDef<ToolInputSchema>>();
});

const spec = {
  initial: "verifying",
  states: {
    verifying: {
      instruction: "Get the caller's policy number and verify it.",
      on: { VERIFIED: "quoting", ABANDON: "closed" },
    },
    quoting: {
      initial: "pending",
      states: {
        pending: { on: { PRICED: "ready" } },
        ready: { on: { QUOTED: "#spec.settled" } },
      },
    },
    settled: { final: true },
    closed: { final: true },
  },
} as const satisfies DialogSpec;

test("a spec's event union is synthesized from its `on` keys, at every depth", () => {
  // `PRICED` and `QUOTED` are two levels down, which is the case a hand-written
  // `types: {} as { events: … }` block most often gets wrong: the union is
  // written once at the top and the nested transitions are added later.
  expectTypeOf<DialogEvent<typeof spec>["type"]>().toEqualTypeOf<
    "ABANDON" | "PRICED" | "QUOTED" | "VERIFIED"
  >();
});

test("a spec-declared dialog types send, sendFrom and the tool's own output", () => {
  const flow = dialog("spec", spec);
  expectTypeOf(flow.send).parameter(1).toEqualTypeOf<DialogEvent<typeof spec>>();
  const verify = flow.tool({
    description: "Verify the policy number",
    when: "verifying",
    send: { type: "VERIFIED" },
    execute: () => ({ ok: true }),
  });
  expectTypeOf<InferToolOutput<typeof verify>>().toEqualTypeOf<
    DialogToolResult<{ ok: boolean }> | ToolFailure
  >();
  expectTypeOf(verify).toExtend<ToolDef<ToolInputSchema>>();
});

test("an event a spec never declares is not in the union a tool can send", () => {
  // Stated as a type RELATION rather than as a suppressed compile error, so the
  // claim is "this event is not one of them" rather than the weaker "the line
  // below fails to compile, for whatever reason".
  const flow = dialog("spec", spec);
  expectTypeOf<{ type: "VERIFEID" }>().not.toExtend<DialogEvent<typeof spec>>();
  expectTypeOf<Parameters<typeof flow.tool>[0]["send"]>().toEqualTypeOf<
    DialogEvent<typeof spec> | undefined
  >();
});

test("a spec's `@` names stay OUT of the event union an author may send", () => {
  // The runtime sends these; nobody writes `send(ctx, { type: "@speech.started" })`.
  const callSpec = {
    initial: "greeting",
    states: {
      greeting: { on: { HEARD: "helping", "@session.timedOut": "abandoned" } },
      helping: { on: { DONE: "abandoned" } },
      abandoned: { final: true },
    },
  } as const satisfies DialogSpec;
  expectTypeOf<DialogEvent<typeof callSpec>["type"]>().toEqualTypeOf<"DONE" | "HEARD">();
  expectTypeOf<{ type: "@session.timedOut" }>().not.toExtend<DialogEvent<typeof callSpec>>();

  // ...and `receive` is how they arrive instead: a wire event, not a dialog one.
  const call = dialog("call", callSpec);
  expectTypeOf(call.receive).parameter(1).toExtend<SessionEvent>();
});

test("a spec keeps its literals and its `onEnter` contextually typed, inline or under `satisfies`", () => {
  // Inline: `const S` keeps the `on` names literal, and the parameter's own
  // constraint types the callbacks — no `as const`, which would drop the
  // latter (`TS7006` on `ctx`).
  const inline = dialog("inline", {
    initial: "a",
    states: {
      a: {
        on: { GO: "b" },
        onEnter: (ctx) => {
          expectTypeOf(ctx).toEqualTypeOf<SlotHolder>();
        },
      },
      b: { final: true },
    },
  });
  expectTypeOf(inline.send).parameter(1).toEqualTypeOf<{ type: "GO" }>();
  // Held in a const: `satisfies` keeps both as well.
  const held = {
    initial: "a",
    states: {
      a: {
        on: { GO: "b" },
        onEnter: (ctx) => {
          expectTypeOf(ctx).toEqualTypeOf<SlotHolder>();
        },
      },
      b: { final: true },
    },
  } satisfies DialogSpec;
  expectTypeOf<DialogEvent<typeof held>["type"]>().toEqualTypeOf<"GO">();
  expectTypeOf(dialog("held", held).send).parameter(1).toEqualTypeOf<{ type: "GO" }>();
});

test("a dialog of any event union is assignable to `AnyDialog`", () => {
  // What `agent({ dialogs: [claim, intake] })` rests on: two dialogs have
  // different event unions by construction, since the names come from their own
  // `on` maps.
  const claim = dialog("claim", spec);
  const other = dialog("other", {
    initial: "start",
    states: { start: { on: { GO: "end" } }, end: { final: true } },
  });
  expectTypeOf(claim).toExtend<AnyDialog>();
  expectTypeOf(other).toExtend<AnyDialog>();
  const dialogs: readonly AnyDialog[] = [claim, other];
  expectTypeOf(dialogs).toExtend<readonly AnyDialog[]>();
});

test("`when` is optional, and `reset` is a flag", () => {
  const peek = claim.tool({ description: "Where are we", reset: true, execute: () => "fresh" });
  expectTypeOf<InferToolOutput<typeof peek>>().toEqualTypeOf<
    DialogToolResult<string> | ToolFailure
  >();
});

test("the field-name `sendFrom` admits only a key holding an event name — checked on the RESULT", () => {
  const body = (): { next?: "QUOTED"; note: string; n: number } => ({ note: "", n: 1 });
  type Want = DialogToolResult<ReturnType<typeof body>> | ToolFailure;
  const byField = claim.tool({ description: "By field", sendFrom: "next", execute: body });
  expectTypeOf<InferToolOutput<typeof byField>>().toEqualTypeOf<Want>();
  // Written ABOVE `execute`, where a callback would see `unknown`: the name needs no ordering.
  const above = claim.tool({ sendFrom: "next", description: "Above", execute: body });
  expectTypeOf<InferToolOutput<typeof above>>().toEqualTypeOf<Want>();
  // A field holding no event name is the misuse TYPE, naming the fields that do.
  const wrong = claim.tool({ description: "Wrong", sendFrom: "note", execute: body });
  expectTypeOf(wrong).toEqualTypeOf<DialogSendFromMisuse<"note", "next">>();
  const absent = claim.tool({ description: "Absent", execute: body }, { sendFrom: "nope" });
  expectTypeOf(absent).toEqualTypeOf<DialogSendFromMisuse<"nope", "next">>();
});

/**
 * The shape the typed key used to break on: an `execute` with an unannotated
 * parameter is CONTEXT-SENSITIVE, so `R` is inferred in a second pass, and a
 * key type spelled over `R` widened the literal to `string` in the first —
 * above, below or in the second argument (`DialogSendFrom` carries the
 * argument). Every template tool is this shape.
 */
test("the field-name `sendFrom` works beside an execute with unannotated parameters", () => {
  type Out = { n: number; next?: "QUOTED" };
  type Want = DialogToolResult<Out> | ToolFailure;
  const below = claim.tool({
    description: "B",
    execute: (_a, _ctx): Out => ({ n: 1 }),
    sendFrom: "next",
  });
  expectTypeOf<InferToolOutput<typeof below>>().toEqualTypeOf<Want>();
  const above = claim.tool({
    description: "A",
    sendFrom: "next",
    execute: (_a, _ctx): Out => ({ n: 1 }),
  });
  expectTypeOf<InferToolOutput<typeof above>>().toEqualTypeOf<Want>();
  const second = claim.tool(
    { description: "S", execute: (_a, _ctx): Out => ({ n: 1 }) },
    { sendFrom: "next" },
  );
  expectTypeOf<InferToolOutput<typeof second>>().toEqualTypeOf<Want>();
  // A body returning through `slot.update(ctx, …)` — `RejectThenableResult<R>` — too.
  const viaSlot = claim.tool({
    description: "V",
    sendFrom: "next",
    execute: (_a, ctx) => cart.update(ctx, (c): Out => ({ n: c.items.length, next: "QUOTED" })),
  });
  expectTypeOf<InferToolOutput<typeof viaSlot>>().toEqualTypeOf<Want>();
  // And the failure arm is subtracted before the key is checked.
  const failing = claim.tool({
    description: "F",
    execute: (_a, _ctx): Out | ToolFailure => ({ n: 1 }),
    sendFrom: "next",
  });
  expectTypeOf<InferToolOutput<typeof failing>>().toEqualTypeOf<Want>();
  const typo = claim.tool({
    description: "T",
    execute: (_a, _ctx): Out => ({ n: 1 }),
    sendFrom: "n",
  });
  expectTypeOf(typo).toEqualTypeOf<DialogSendFromMisuse<"n", "next">>();
});

test("a gated updateTool subtracts the failure arm for both sendFrom forms, prepare or not", () => {
  type Out = { n: number; next?: "QUOTED" };
  type Want = DialogToolResult<Out> | ToolFailure;
  const byField = cart.updateTool({
    description: "Add, gated by field",
    dialog: claim,
    inputSchema: z.object({ item: z.string() }),
    execute: ({ item }, c): Out | ToolFailure => {
      if (item === "") return { error: "no" };
      c.items.push(item);
      return { n: c.items.length, next: "QUOTED" };
    },
    sendFrom: "next",
  });
  expectTypeOf<InferToolOutput<typeof byField>>().toEqualTypeOf<Want>();
  cart.updateTool({
    description: "Add, gated by function",
    dialog: claim,
    execute: (_a, c): Out | ToolFailure => ({ n: c.items.length }),
    sendFrom: (result) => {
      expectTypeOf(result).toEqualTypeOf<Out>();
    },
  });
  cart.updateTool(
    {
      description: "Add, gated in the options",
      dialog: claim,
      execute: (_a, c): Out | ToolFailure => ({ n: c.items.length }),
    },
    {
      sendFrom: (result) => {
        expectTypeOf(result).toEqualTypeOf<Out>();
      },
    },
  );
  const prepared = cart.updateTool({
    description: "Prepared and gated by field",
    dialog: claim,
    prepare: async (_a, c) => c.items.length,
    execute: (_a, _c, n): Out => ({ n, next: "QUOTED" }),
    sendFrom: "next",
  });
  expectTypeOf<InferToolOutput<typeof prepared>>().toEqualTypeOf<Want>();
  const preparedFn = cart.updateTool({
    description: "Prepared and gated by function",
    dialog: claim,
    prepare: async (_a, c) => c.items.length,
    execute: (_a, _c, n): Out | ToolFailure => ({ n }),
    sendFrom: (result) => {
      expectTypeOf(result).toEqualTypeOf<Out>();
    },
  });
  expectTypeOf<InferToolOutput<typeof preparedFn>>().toEqualTypeOf<Want>();
});

test("the second-argument `sendFrom` sees the body's success type, whatever the def's order", () => {
  claim.tool(
    { description: "Quote", execute: quoteBody },
    {
      sendFrom: (result) => {
        expectTypeOf(result).toEqualTypeOf<{ premium: number }>();
      },
    },
  );
});

test("a slot tool carrying a dialog answers the envelope, with E read from the dialog", () => {
  const gated = cart.tool({
    description: "Count, gated",
    dialog: claim,
    when: "quoting",
    send: { type: "QUOTED" },
    execute: (_args, value) => ({ count: value.items.length }),
  });
  expectTypeOf<InferToolOutput<typeof gated>>().toEqualTypeOf<
    DialogToolResult<{ count: number }> | ToolFailure
  >();
  expectTypeOf(gated).toExtend<ToolDef<ToolInputSchema>>();
  // An event the dialog does not declare is not a `send`.
  type Gate = Parameters<typeof cart.tool<ToolInputSchema, unknown, { type: "QUOTED" }>>[0];
  expectTypeOf<{ type: "NOPE" }>().not.toExtend<NonNullable<Gate["send"]>>();
});

test("updateTool: `require`, `report` and `prepare` thread their types through", () => {
  const reported = cart.updateTool({
    description: "Add, reported",
    inputSchema: z.object({ item: z.string() }),
    require: (value, args) => {
      expectTypeOf(value).toEqualTypeOf<{ readonly items: readonly string[] }>();
      expectTypeOf(args).toEqualTypeOf<{ item: string }>();
    },
    execute: ({ item }, draft) => {
      draft.items.push(item);
      return { added: item };
    },
    report: (stored, partial) => ({ ...partial, count: stored.items.length }),
  });
  expectTypeOf<InferToolOutput<typeof reported>>().toEqualTypeOf<{
    added: string;
    count: number;
  }>();

  const prepared = cart.updateTool({
    description: "Add, prepared",
    prepare: async (_args, value) => value.items.length * 2,
    execute: (_args, draft, quote, ctx) => {
      expectTypeOf(draft).toEqualTypeOf<{ items: string[] }>();
      expectTypeOf(quote).toEqualTypeOf<number>();
      expectTypeOf(ctx.sessionId).toBeString();
      return { quote };
    },
  });
  expectTypeOf<InferToolOutput<typeof prepared>>().toEqualTypeOf<{ quote: number } | ToolFailure>();

  const both = cart.updateTool({
    description: "Add, prepared and gated",
    dialog: claim,
    prepare: () => 1,
    execute: (_args, _draft, n) => ({ n }),
    report: (_stored, partial): { n: number; next?: "QUOTED" } => ({ ...partial, next: "QUOTED" }),
    sendFrom: "next",
  });
  expectTypeOf<InferToolOutput<typeof both>>().toEqualTypeOf<
    DialogToolResult<{ n: number; next?: "QUOTED" }> | ToolFailure
  >();
});

test("transact types `prepare` into `commit`", () => {
  const ctx = {} as SlotHolder;
  const run = cart.transact(ctx, {
    prepare: async (value) => value.items.length,
    commit: (draft, n) => {
      expectTypeOf(draft).toEqualTypeOf<{ items: string[] }>();
      expectTypeOf(n).toEqualTypeOf<number>();
      return { n };
    },
  });
  expectTypeOf(run).toEqualTypeOf<Promise<{ n: number } | ToolFailure>>();
});
