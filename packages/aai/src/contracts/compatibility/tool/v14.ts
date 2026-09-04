// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:tool` epoch 14.
 *
 * A `tools/` module for a parts desk — the ordinary shape of a tool that talks
 * to somebody else's HTTP API: a zod input schema, a credential read through
 * {@link requireEnv}, a {@link ToolFailure} for the case the model should
 * recover from, and a second tool that hands the slow half to a durable run
 * rather than making the caller wait on the line for it. Written the way it was
 * authored at epoch 14, and it must keep compiling for as long as that epoch is
 * advertised as supported.
 *
 * ## What moved, and why epoch 14 survives it
 *
 * Nothing in this capability's own surface. `aai:tool`'s export list is
 * byte-identical across the bump — `tool`, `ToolDef`, `ToolContext`,
 * `ToolFailure`, `toolFailure`, `isToolFailure`, `requireEnv`, `Message`, the
 * three `Infer*` helpers, `DefaultToolResult` — and the report hash moved for a
 * name none of them is: `WorkflowBody`'s second parameter type was renamed
 * `WorkflowCtx` -> `WorkflowContext`.
 *
 * It reaches this report through exactly one member, and this file uses that
 * member on purpose. `ToolContext.workflows` is a `WorkflowClient`, whose
 * `start` overload takes a `WorkflowDef`, whose `run` is a `WorkflowBody` — so
 * the renamed type is four hops from `tool()` and in the rollup either way.
 * {@link orderPart} below calls that overload and {@link partsRestock} is the
 * def it names, and NEITHER writes the type down: a workflow body's second
 * parameter is INFERRED from `workflow({ run })`, which is how every template
 * writes one. A rename cannot break a name nobody spells.
 *
 * **The direction that WOULD break this file is a SIGNATURE.** Every function
 * here is invoked and none is implemented, so nothing is insulated the way an
 * interface's consumer is by a member turning optional: `ToolFailure` gaining a
 * required second field, `requireEnv` taking a third argument, `ToolDef.execute`
 * losing its `ctx` parameter, or `ctx.workflows.start` dropping the def overload
 * in favour of the string one. Each reddens here, and each is a real break for
 * every tool module in every user project.
 *
 * Editing this file to make a future error go away defeats the mechanism: the
 * error IS the finding, and it means epoch 14 has to be dropped with a reason.
 */

import { z } from "zod";
import {
  type DefaultToolResult,
  type InferSchemaOutput,
  type InferToolInput,
  type InferToolOutput,
  isToolFailure,
  type Message,
  requireEnv,
  type ToolContext,
  type ToolDef,
  type ToolFailure,
  type ToolInputSchema,
  tool,
  toolFailure,
  workflow,
} from "../../../index.ts";

/** ── EDIT: what the parts API answers with. ────────────────────────────── */
type PartQuote = { sku: string; description: string; priceCents: number; inStock: number };

/**
 * ── EDIT: the one place the credential is read. ──────────────────────────
 *
 * `requireEnv` rather than `ctx.env.PARTS_API_KEY ?? ""`, and the difference is
 * where the failure lands: the helper throws a sentence naming the variable and
 * pointing at `agent({ requiredEnv })`, where an empty-string fallback sends an
 * unauthenticated request and reports the vendor's `401` as the tool's answer.
 *
 * It takes `{ env }` rather than a whole {@link ToolContext}, which is what lets
 * a helper like this one be called from a session event handler too.
 */
function partsKey(ctx: Pick<ToolContext, "env">): string {
  return requireEnv(ctx, "PARTS_API_KEY");
}

/**
 * The catalog read both tools do, in one place.
 *
 * `ctx.signal` is threaded into the fetch: a network call is the slowest thing
 * this desk does and the first thing a barge-in wants back, and the executor
 * aborts it on cancellation and on the call's own timeout.
 *
 * A SKU the vendor has never heard of is a {@link ToolFailure}, not a throw. It
 * is the ordinary case — a caller reads a number off a box and gets a digit
 * wrong — and a failure goes back to the model as a tool result it can recover
 * from, where a throw is reported as the agent breaking. It is returned rather
 * than handled here so both call sites decide what to say about it.
 */
async function fetchQuote(sku: string, ctx: ToolContext): Promise<PartQuote | ToolFailure> {
  const response = await fetch(`https://parts.example.com/v1/skus/${sku}`, {
    headers: { authorization: `Bearer ${partsKey(ctx)}` },
    signal: ctx.signal,
  });
  if (response.status === 404) {
    return toolFailure(`No part matches SKU ${sku}. Ask the caller to read it back to you.`);
  }
  if (!response.ok) {
    return toolFailure(`The parts catalog is not answering (${response.status}). Try again.`);
  }
  return (await response.json()) as PartQuote;
}

/** Look a part up by SKU — the read the model reaches for first. */
export const lookupPart = tool({
  description: "Look up a part by its SKU. Returns the price and how many are in stock.",
  inputSchema: z.object({
    sku: z.string().max(32).describe("The part number printed on the box, e.g. 'HX-4410'"),
  }),
  execute: ({ sku }, ctx) => fetchQuote(sku, ctx),
});

/**
 * ── EDIT: the work that must outlive the call. ───────────────────────────
 *
 * A restock takes minutes and the caller is on the line, so the ordering tool
 * below does not do it: it starts a durable RUN and answers the turn. The run
 * continues on the queue after the session ends, which is the whole reason this
 * is a `workflow()` and not a slow branch inside `execute`.
 *
 * **The `ctx` parameter is the whole of the "what moved" note above.** It is
 * inferred from this declaration — the body is checked against
 * `WorkflowBody<{ sku: string; quantity: number }, …>`, whose second parameter
 * the SDK names and this file does not. Annotating it here would be the one
 * edit that turns a rename into a compile error, which is exactly why no
 * template does it and why the epoch survives.
 */
export const partsRestock = workflow({
  description: "Order a part from the distributor and confirm the delivery window",
  input: z.object({ sku: z.string().max(32), quantity: z.number().int().min(1).max(99) }),
  run: async (input, ctx) => {
    // A step is keyed by its NAME, so the name has to be a literal — a name
    // built at run time re-executes the step on every replay.
    const order = await ctx.step("place", async () => ({
      reference: `PO-${input.sku}-${input.quantity}`,
    }));
    const promisedAt = await ctx.step("promise", () => ctx.now());
    return { reference: order.reference, promisedAt };
  },
});

/**
 * Order a part, and answer the turn rather than the order.
 *
 * `{ key: ctx.sessionId }` is what makes the run findable again: a later turn —
 * or a later CALL from the same caller — reaches it with `ctx.workflows.find`
 * instead of holding a run id nobody wrote down.
 *
 * The def overload is the one to reach for. Passing `partsRestock` rather than
 * `"partsRestock"` is what type-checks the input against the workflow's own
 * schema at the call site, so a renamed field is an error here instead of a
 * validation failure inside a run somebody has to go and read.
 */
export const orderPart = tool({
  description: "Order a part for a customer. Use after lookup_part has confirmed the SKU.",
  inputSchema: z.object({
    sku: z.string().max(32),
    quantity: z.number().int().min(1).max(99).default(1),
  }),
  execute: async ({ sku, quantity }, ctx) => {
    const quote = await fetchQuote(sku, ctx);
    // The guard, and the reason the tool above returns a union rather than
    // throwing: an unnarrowed read here would price a failure at `undefined`.
    if (isToolFailure(quote)) return quote;
    if (quote.inStock < quantity) {
      return toolFailure(
        `Only ${quote.inStock} of ${sku} are in stock. Offer the caller what is left.`,
      );
    }
    const runId = await ctx.workflows.start(
      partsRestock,
      { sku, quantity },
      { key: ctx.sessionId },
    );
    // Fire-and-forget to whatever chrome the session is rendering. Dropped
    // rather than thrown when it is too big, so a UI nicety cannot fail a call.
    ctx.send("order.placed", { sku, quantity, runId });
    return { sku, quantity, totalCents: quote.priceCents * quantity, runId };
  },
});

/**
 * ── EDIT: what a custom client renders. ──────────────────────────────────
 *
 * The two `Infer*` helpers exist so the browser half of an agent derives these
 * from the tool rather than restating them. A hand-written copy is a second
 * source of truth that stops matching the first silently, on the turn after
 * somebody adds a field.
 */
export type OrderPartInput = InferToolInput<typeof orderPart>;
export type OrderPartOutput = InferToolOutput<typeof orderPart>;

/**
 * ── EDIT: the wrapper every tool on this desk goes through. ──────────────
 *
 * A per-agent wrapper is what a project ends up with once more than a couple of
 * tools share a rule — here the description suffix the model reads, so no tool
 * module restates it. It is generic over {@link ToolInputSchema} rather than
 * over a concrete schema, which is what keeps `args` typed for the body it
 * forwards to: {@link InferSchemaOutput} is the same reading of the schema that
 * `tool()` itself does, so the wrapper adds no second opinion about what a
 * tool's arguments are.
 */
export function deskTool<P extends ToolInputSchema, R>(def: ToolDef<P, R>): ToolDef<P, R> {
  return {
    ...def,
    description: `${def.description} (parts desk)`,
    execute: (args: InferSchemaOutput<P>, ctx: ToolContext) => def.execute(args, ctx),
  };
}

/**
 * What a client that does NOT name this tool's output reads back.
 *
 * {@link DefaultToolResult} is `any`, deliberately, and naming it is how a
 * client says so out loud: the browser hooks default their result parameter to
 * it, so an unparameterized read compiles and is unchecked. Tightening it to
 * `unknown` would be a breaking change for every untyped client, which is why
 * it is a published name rather than an implementation detail — and why a page
 * that cares reaches for {@link OrderPartOutput} above instead.
 */
export type UntypedDeskResult = DefaultToolResult;

/**
 * ── EDIT: the set a subagent or a spec is handed. ────────────────────────
 *
 * A `tools/` file IS a tool, so nothing registers these for the AGENT. This map
 * is for the narrower places that take one explicitly — `subagent({ tools })`,
 * or a spec driving a tool directly — and it is typed as the contract's own
 * {@link ToolDef} so a tool that stopped being one is an error here.
 */
export const partsDeskTools: Readonly<Record<string, ToolDef>> = {
  lookup_part: deskTool(lookupPart),
  order_part: deskTool(orderPart),
};

/**
 * The last thing the caller actually said, for a tool that has to quote it.
 *
 * `ctx.messages` is the conversation as the loop has it — readonly, and typed
 * as {@link Message}, which is the vocabulary a tool names when it reaches past
 * its own arguments.
 */
export function lastCallerTurn(messages: readonly Message[]): string | undefined {
  return messages.findLast((message) => message.role === "user")?.content;
}
