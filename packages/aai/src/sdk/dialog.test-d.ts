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
import type { DialogEvent, DialogSpec, DialogToolResult } from "./dialog-types.ts";
import type { SessionEvent } from "./protocol-events.ts";
import type { ToolInputSchema } from "./schema.ts";
import { sessionSlot } from "./session-slot.ts";
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
      greeting: { on: { HEARD: "helping", "@session.timed-out": "abandoned" } },
      helping: { on: { DONE: "abandoned" } },
      abandoned: { final: true },
    },
  } as const satisfies DialogSpec;
  expectTypeOf<DialogEvent<typeof callSpec>["type"]>().toEqualTypeOf<"DONE" | "HEARD">();
  expectTypeOf<{ type: "@session.timed-out" }>().not.toExtend<DialogEvent<typeof callSpec>>();

  // ...and `receive` is how they arrive instead: a wire event, not a dialog one.
  const call = dialog("call", callSpec);
  expectTypeOf(call.receive).parameter(1).toExtend<SessionEvent>();
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
