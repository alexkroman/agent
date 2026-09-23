// Copyright 2026 the AAI authors. MIT license.
/**
 * Type-level tests for the `AgentDef` field GROUPS — the model-tuning knobs,
 * the two guardrail arrays, the `systemPrompt` resolver and the context every
 * per-session author function receives.
 *
 * Split out of `define.test-d.ts` when that file reached the 700-line test cap.
 * The seam is the one the guide draws: each of these groups is an interface
 * `AgentDef` extends because its fields share ONE rule, so what they owe a type
 * test is the same question four times — which arm of `AgentParams` accepts
 * them — rather than the per-field coverage the parent file gives everything
 * else.
 *
 * @module
 */

import { expectTypeOf, test } from "vitest";
import type { AgentGuardrail, GuardrailVerdict } from "./agent-guardrails.ts";
import type { AgentInstructions, AgentSystemPrompt } from "./agent-instructions.ts";
import type { AgentSessionContext } from "./agent-session-context.ts";
import { type AgentParams, agent } from "./define.ts";
import { type PersonaDef, type Personas, persona, personas } from "./persona.ts";
import type { S2sProvider } from "./providers.ts";
import type { SessionEventContext } from "./session-events.ts";
import type { SubagentDef } from "./subagent.ts";
import type { ToolSet } from "./tool-def.ts";
import type { AgentDef, ToolContext } from "./types.ts";

/**
 * The five model-tuning knobs, both guardrails and the `description` are on
 * every SESSION arm and on none of the workflow app.
 *
 * They are refused at CONFIG time rather than by the type on the s2s and text
 * arms — the same treatment `temperature` has always had, and for the reason
 * `StaticAgentParamsCore` records: a message on one arm of this union is a
 * message in every diagnostic tsc prints, including a plain voice agent's
 * one-character mistake. What the TYPE settles is that they are declarable at
 * all, and that a workflow app (which runs no model and speaks nothing) cannot.
 */
test("the model-tuning knobs and the guardrails are session-arm fields", () => {
  expectTypeOf<{
    name: string;
    description: string;
    temperature: number;
    maxOutputTokens: number;
    maxRetries: number;
    resetToolChoice: boolean;
    usageLimits: { totalTokens: number };
  }>().toExtend<AgentParams>();

  expectTypeOf<{
    name: string;
    inputGuardrails: readonly AgentGuardrail[];
    outputGuardrails: readonly AgentGuardrail[];
  }>().toExtend<AgentParams>();

  // A text agent declares them too — none of these is voice-specific, and the
  // one rule they share is about who assembles the request.
  expectTypeOf<{ name: string; text: true; maxOutputTokens: number }>().toExtend<AgentParams>();

  // A workflow app runs no model and opens no session, so all seven are the
  // same silent no-op the rest of `WorkflowAppOnlyField` is.
  expectTypeOf<{
    name: string;
    page: "static";
    workflows: NonNullable<AgentDef["workflows"]>;
    maxOutputTokens: number;
  }>().not.toExtend<AgentParams>();
  expectTypeOf<{
    name: string;
    page: "static";
    workflows: NonNullable<AgentDef["workflows"]>;
    outputGuardrails: readonly AgentGuardrail[];
  }>().not.toExtend<AgentParams>();

  // `description` is deliberately NOT refused there: a listing wants one
  // whatever the front door is.
  expectTypeOf<{
    name: string;
    page: "static";
    workflows: NonNullable<AgentDef["workflows"]>;
    description: string;
  }>().toExtend<AgentParams>();
});

/**
 * `systemPrompt` takes a RESOLVER as well as a string, in every mode, and it is
 * handed the session rather than nothing — a nullary thunk could vary the
 * prompt by wall clock alone, so it could not read a slot, which is most of the
 * reason to want one. One is still assignable (pinned below), so a builder
 * written against that older shape keeps compiling. The widening is in turn
 * only useful if `agent()` hands the FUNCTION back: narrowed to `string` on the
 * way out it compiles everywhere and freezes every dynamic prompt at its first
 * answer, reported nowhere. The MODE arms are named one by one because
 * `AgentParams` is a union and a field re-declared on one arm is a field the
 * others may not carry — how `sttPrompt` above came to be refused in S2S mode.
 */
test("systemPrompt accepts a per-request resolver", () => {
  type Resolve = (ctx: AgentSessionContext) => string;
  expectTypeOf(
    agent({ name: "T", systemPrompt: (ctx: AgentSessionContext) => ctx.sessionId }).systemPrompt,
  ).toEqualTypeOf<AgentSystemPrompt>();
  expectTypeOf<() => string>().toExtend<AgentInstructions>();
  expectTypeOf<AgentInstructions>().parameter(0).toEqualTypeOf<AgentSessionContext>();
  expectTypeOf<AgentInstructions>().returns.toBeString();
  expectTypeOf<{ name: string; systemPrompt: string }>().toExtend<AgentParams>();
  expectTypeOf<{ name: string; systemPrompt: Resolve }>().toExtend<AgentParams>();
  expectTypeOf<{ name: string; s2s: S2sProvider; systemPrompt: Resolve }>().toExtend<AgentParams>();
  expectTypeOf<{ name: string; text: true; systemPrompt: Resolve }>().toExtend<AgentParams>();
  // An ASYNC resolver is refused: there is nowhere to await while a request is
  // being assembled that does not put a round trip in front of every turn.
  expectTypeOf<{
    name: string;
    systemPrompt: (ctx: AgentSessionContext) => Promise<string>;
  }>().not.toExtend<AgentParams>();
});

/** A guardrail's verdict vocabulary is the subagent's, deliberately. */
test("an agent guardrail answers a GuardrailVerdict", () => {
  expectTypeOf<(text: string, ctx: AgentSessionContext) => true>().toExtend<AgentGuardrail>();
  expectTypeOf<(text: string, ctx: AgentSessionContext) => string>().toExtend<AgentGuardrail>();
  expectTypeOf<
    (text: string, ctx: AgentSessionContext) => Promise<GuardrailVerdict>
  >().toExtend<AgentGuardrail>();
  // A verdict that is neither an acceptance nor a reason is not a verdict.
  expectTypeOf<(text: string, ctx: AgentSessionContext) => false>().not.toExtend<AgentGuardrail>();
});

/**
 * The twins may not DRIFT, and this is what makes that a compile error.
 *
 * {@link AgentSessionContext} (what a `systemPrompt` resolver and both
 * guardrails are handed) and `SessionEventContext` (what an `events` handler is
 * handed) are deliberately the same shape and deliberately two declarations:
 * they are read by different audiences and their per-field docs argue different
 * things — a resolver runs on every request, where a handler's write is
 * committed after it returns. Collapsing one into an alias of the other would
 * make that drift unrepresentable at the cost of the second reference page, so
 * the drift is pinned here instead.
 *
 * Mutual assignability BOTH ways is the assertion: one direction alone passes
 * while the other side gains a field, which is exactly the drift to catch. A
 * capability added to one belongs on the other unless there is a reason it does
 * not — and that reason is a deliberate edit to this test.
 */
test("AgentSessionContext and SessionEventContext are the same shape", () => {
  expectTypeOf<AgentSessionContext>().toExtend<SessionEventContext>();
  expectTypeOf<SessionEventContext>().toExtend<AgentSessionContext>();
  expectTypeOf<keyof AgentSessionContext>().toEqualTypeOf<keyof SessionEventContext>();
});

/**
 * A roster knows its own names. `persona()` infers each `name` as a literal and
 * `personas()` collects them, so a handoff to a desk that is not on the roster
 * is a compile error in the tool body rather than a throw on a live call. The
 * default parameter keeps a bare `Personas` annotation accepting any roster.
 */
test("persona names are inferred, and a mistyped handoff target does not compile", () => {
  const triage = persona({ name: "triage", description: "d", systemPrompt: "p" });
  const billing = persona({ name: "billing", description: "d", systemPrompt: "p" });
  expectTypeOf(triage).toEqualTypeOf<PersonaDef<"triage">>();
  const desk = personas([triage, billing]);
  expectTypeOf(desk).toEqualTypeOf<Personas<"triage" | "billing">>();
  const ctx = {} as ToolContext;
  desk.handoff(ctx, "billing");
  desk.handoff(ctx, billing);
  // @ts-expect-error — "biling" is not on the roster.
  desk.handoff(ctx, "biling");
  // @ts-expect-error — nor is a persona declared for another roster.
  desk.handoff(ctx, persona({ name: "sales", description: "d", systemPrompt: "p" }));
  // Backward compatible: the default is `string`, and a typed roster fits it.
  const loose: Personas = desk;
  loose.handoff(ctx, "anyone");
  expectTypeOf<PersonaDef>().toEqualTypeOf<PersonaDef<string>>();
});

/**
 * `ClientEventMap` types `ctx.send` for the events an agent DECLARES, and only
 * those: a declared name with the wrong payload fails, and an undeclared name
 * still takes anything. The augmentation at the bottom of this file is the
 * test's own event name.
 */
test("ctx.send is typed by ClientEventMap, per declared event", () => {
  const ctx = {} as ToolContext;
  ctx.send("typetest.progress", { done: 1, total: 2 });
  // @ts-expect-error — a declared event's payload is checked.
  ctx.send("typetest.progress", { done: "1", total: 2 });
  // @ts-expect-error — including a missing field.
  ctx.send("typetest.progress", { done: 1 });
  ctx.send("anything.else", { whatever: true });
  const name: string = "dynamic";
  ctx.send(name, 42);
});

test("ToolSet is the one tool-map shape AgentDef, PersonaDef and SubagentDef share", () => {
  expectTypeOf<AgentDef["tools"]>().toEqualTypeOf<ToolSet>();
  expectTypeOf<NonNullable<PersonaDef["tools"]>>().toEqualTypeOf<ToolSet>();
  expectTypeOf<NonNullable<SubagentDef["tools"]>>().toEqualTypeOf<ToolSet>();
});

declare module "./session-event-map.ts" {
  interface ClientEventMap {
    "typetest.progress": { done: number; total: number };
  }
}
