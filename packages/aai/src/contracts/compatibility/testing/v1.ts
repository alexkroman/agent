// Copyright 2025 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:testing` epoch 1.
 *
 * A tool spec as it was written against epoch 1: a context built with
 * `createToolContext`, the tool under test reached by name through
 * `toolRunner` / `runTool` / `toolOf`, the scripted model and desk, and the
 * dialog, event and schema unwraps. It must keep compiling against current
 * source for as long as epoch 1 is advertised as supported.
 *
 * What epoch 2 moved, and why this file still compiles:
 *
 * - `toolOf` answers the new `ToolDef` default, whose `inputSchema` may be
 *   `undefined`; a spec reads `description` and `inputSchema` off it, as below.
 * - `ToolRunner` is an overloaded `@sealed` interface over the old alias; a
 *   spec calls `run(name, args, ctx)` exactly as it did.
 * - `ToolContextOverrides.call` takes `SessionCallInput` — the carrier, call id
 *   and parameters a writer hands in, which is everything `SessionCall` was at
 *   epoch 1. The probe reports `call.brief` removed because it reads today's
 *   `SessionCall` on both sides; the reader did not exist then.
 */

import { z } from "zod";
import { type SpeakerDef, type ToolDef, tool, toolFailure } from "../../../index.ts";
import {
  createSlotStore,
  createToolContext,
  dialogRefusalPattern,
  dialogResultSchema,
  endSessionCalls,
  eventsOf,
  expectDialogOk,
  expectDialogRefused,
  expectToolOk,
  isEvent,
  parseSchemaInput,
  parseToolInput,
  runGuardrail,
  runTool,
  type SaidLine,
  type SentEvent,
  type StubDelegate,
  type StubDelegateCall,
  type StubDelegateReply,
  type StubDelegateRoute,
  type StubDelegateScript,
  type StubGenerate,
  type StubGenerateCall,
  type StubGenerateReply,
  type StubGenerateRoute,
  type StubGenerateScript,
  schemaInputIssues,
  stubDelegate,
  stubGenerate,
  type TestToolContext,
  type ToolBearingAgent,
  type ToolContextOverrides,
  type ToolRunner,
  toolInputIssues,
  toolOf,
  toolRunner,
} from "../../../sdk/testing-barrel.ts";

// --- The tools under test ----------------------------------------------------

const addItem = tool({
  description: "Add an item to the cart.",
  inputSchema: z.object({ item: z.string(), qty: z.number().int().positive() }),
  execute: ({ item, qty }, ctx) => {
    ctx.send("cart.changed", { item, qty });
    return { item, qty, sessionId: ctx.sessionId };
  },
});

const checkout = tool({
  description: "Check the cart out.",
  execute: (_args, ctx) =>
    ctx.messages.length > 0 ? { ok: true } : toolFailure("Nothing to check out."),
});

export const agent: ToolBearingAgent = { tools: { add_item: addItem, checkout } };

// --- The scripted collaborators ---------------------------------------------

const summaryRoute: StubGenerateRoute = "Two apples.";
const objectRoute: StubGenerateRoute = (call: StubGenerateCall): StubGenerateReply => ({
  object: { prompt: call.prompt, system: call.system },
});
const modelScript: StubGenerateScript = { routes: { summary: summaryRoute, default: objectRoute } };
export const model: StubGenerate = stubGenerate(modelScript);

const deskRoute: StubDelegateRoute = (call: StubDelegateCall): StubDelegateReply => ({
  text: `Done: ${call.task}`,
  steps: 1,
});
const deskScript: StubDelegateScript = { reply: deskRoute };
export const desk: StubDelegate = stubDelegate(deskScript);

// --- The context, with the call the session arrived on ------------------------

const overrides: ToolContextOverrides = {
  sessionId: "session-1",
  env: { SHOP_API_KEY: "test-key" },
  slots: createSlotStore(),
  model,
  desk,
  clientId: "device-1",
  clientPhone: "+15550100",
  clientLocation: "Austin, TX",
  call: { carrier: "twilio", callId: "CA123", parameters: { campaign: "spring" } },
};
export const ctx: TestToolContext = createToolContext(overrides);
export const run: ToolRunner = toolRunner(agent);

// --- Running tools, three ways --------------------------------------------

export async function addsAnApple(): Promise<{ item: string; qty: number }> {
  const result = await run("add_item", { item: "apple", qty: 1 }, ctx);
  const added = expectToolOk<{ item: string; qty: number }>(result);
  const sent: readonly SentEvent[] = ctx.sent;
  const said: readonly SaidLine[] = ctx.said;
  if (sent.length === 0 || said.length > 0) throw new Error("expected one event and no speech");
  const typed = await runTool(addItem, { item: "pear", qty: 2 }, ctx);
  const byName = expectToolOk(await runTool(agent, "checkout", ctx));
  const ended = endSessionCalls(ctx);
  return { item: added.item, qty: added.qty + typed.qty + (byName ? 0 : 1) + ended.length };
}

export function declares(): string {
  const def: ToolDef = toolOf(agent, "add_item");
  return `${def.description} (${def.inputSchema ? "with" : "without"} a schema)`;
}

// --- The schema pair --------------------------------------------------------

export async function accepts(): Promise<boolean> {
  const parsed = await parseToolInput<{ item: string; qty: number }>(agent, "add_item", {
    item: "apple",
    qty: 1,
  });
  const issues = await toolInputIssues(agent, "add_item", { item: 1 });
  const direct = await parseSchemaInput<{ item: string }>(addItem.inputSchema, {
    item: "fig",
    qty: 3,
  });
  const directIssues = await schemaInputIssues(addItem.inputSchema, {});
  return (
    parsed.qty === 1 && issues !== undefined && direct.item === "fig" && directIssues !== undefined
  );
}

// --- Dialog and event unwraps ------------------------------------------------

const ResultSchema = dialogResultSchema(z.object({ ok: z.boolean() }));

export function unwraps(result: unknown): string {
  const envelope = expectDialogOk<{ ok: boolean }>(result);
  const refusal = expectDialogRefused(result, "idle");
  const parsed = ResultSchema.parse(result);
  return dialogRefusalPattern("idle").test(refusal.error)
    ? `${envelope.state}:${String(parsed.done)}`
    : refusal.error;
}

type SessionLike = { type: "tool.called"; name: string } | { type: "reply.completed" };

export function toolCallsIn(events: readonly SessionLike[]): string[] {
  const names: string[] = [];
  for (const event of events) if (isEvent(event, "tool.called")) names.push(event.name);
  return [...names, ...eventsOf(events, "tool.called").map((event) => event.name)];
}

// --- A speaker's guardrail ---------------------------------------------------

const concierge: SpeakerDef = { name: "concierge", systemPrompt: "Book rooms; refuse refunds." };

export function refusesRefunds(): boolean {
  const verdict = runGuardrail(concierge, "Refund me.", { text: "I cannot do that." });
  return verdict === true;
}
