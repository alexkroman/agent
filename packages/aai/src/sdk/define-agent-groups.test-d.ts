// Copyright 2026 the AAI authors. MIT license.
/**
 * Type-level tests for the `AgentDef` field GROUPS — the model-tuning knobs,
 * the two guardrail arrays, the prompt resolvers and the context every
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
import type { AgentAccepts } from "./_test-utils.ts";
import type { AgentGuardrail, GuardrailVerdict } from "./agent-guardrails.ts";
import type { AgentPromptContext, AgentSystemPrompt } from "./agent-instructions.ts";
import type { AgentSessionContext } from "./agent-session-context.ts";
import { agent } from "./define.ts";
import type { S2sProvider } from "./providers.ts";
import { type Roster, roster } from "./roster.ts";
import type { SessionEventContext } from "./session-events.ts";
import type { SessionSpeech } from "./session-speech.ts";
import { type SpeakerDef, speaker } from "./speaker.ts";
import type { ToolMap } from "./tool-def.ts";
import type { AgentDef, ToolContext } from "./types.ts";

/** The function half of `AgentSystemPrompt`: a resolver. */
type Resolver = Exclude<AgentSystemPrompt, string>;

/**
 * The five model-tuning knobs, both guardrails and the `listing` are on
 * every SESSION arm and on none of the workflow app.
 *
 * They are refused at CONFIG time rather than by the type on the s2s and text
 * arms — the same treatment `temperature` has always had, and for the reason
 * `WorkflowAppAgentParams` records: a message on one arm of this union is a
 * message in every diagnostic tsc prints, including a plain voice agent's
 * one-character mistake. What the TYPE settles is that they are declarable at
 * all, and that a workflow app (which runs no model and speaks nothing) cannot.
 */
test("the model-tuning knobs and the guardrails are session-arm fields", () => {
  expectTypeOf<
    AgentAccepts<{
      name: string;
      listing: string;
      temperature: number;
      maxOutputTokens: number;
      maxRetries: number;
      resetToolChoice: boolean;
      usageLimits: { totalTokens: number };
    }>
  >().toEqualTypeOf<true>();

  expectTypeOf<
    AgentAccepts<{
      name: string;
      inputGuardrails: readonly AgentGuardrail[];
      outputGuardrails: readonly AgentGuardrail[];
    }>
  >().toEqualTypeOf<true>();

  // A text agent declares them too — none of these is voice-specific, and the
  // one rule they share is about who assembles the request.
  expectTypeOf<
    AgentAccepts<{ name: string; mode: "text"; maxOutputTokens: number }>
  >().toEqualTypeOf<true>();

  // A workflow app runs no model and opens no session, so all seven are the
  // same silent no-op every field the workflow-app member lacks is.
  expectTypeOf<
    AgentAccepts<{
      name: string;
      mode: "workflow-app";
      workflows: NonNullable<AgentDef["workflows"]>;
      maxOutputTokens: number;
    }>
  >().toEqualTypeOf<false>();
  expectTypeOf<
    AgentAccepts<{
      name: string;
      mode: "workflow-app";
      workflows: NonNullable<AgentDef["workflows"]>;
      outputGuardrails: readonly AgentGuardrail[];
    }>
  >().toEqualTypeOf<false>();

  // `listing` is deliberately NOT refused there: a listing wants one whatever
  // the front door is. Its old name `description` is gone from every arm.
  expectTypeOf<
    AgentAccepts<{
      name: string;
      mode: "workflow-app";
      workflows: NonNullable<AgentDef["workflows"]>;
      listing: string;
    }>
  >().toEqualTypeOf<true>();
  expectTypeOf<AgentAccepts<{ name: string; description: string }>>().toEqualTypeOf<false>();
});

/**
 * `promptContext` (`agent-instructions.ts`) is declarable in every session
 * mode, in both forms, and refused by the workflow-app member: nothing there
 * reads a prompt. It is the ONE prompt field an `agent.ts` writes.
 */
test("promptContext takes a string or a session resolver on every session arm, and no workflow app", () => {
  expectTypeOf<AgentAccepts<{ name: string; promptContext: string }>>().toEqualTypeOf<true>();
  expectTypeOf<
    AgentAccepts<{ name: string; promptContext: (ctx: AgentSessionContext) => string }>
  >().toEqualTypeOf<true>();
  expectTypeOf<
    AgentAccepts<{ name: string; mode: "text"; promptContext: string }>
  >().toEqualTypeOf<true>();
  expectTypeOf<
    AgentAccepts<{
      name: string;
      mode: "workflow-app";
      workflows: NonNullable<AgentDef["workflows"]>;
      promptContext: string;
    }>
  >().toEqualTypeOf<false>();
  // `agent()` hands the function back unchanged.
  const def = agent({ name: "a", promptContext: (ctx) => ctx.sessionId });
  expectTypeOf(def.promptContext).toEqualTypeOf<AgentPromptContext | undefined>();
  // An ASYNC resolver is refused: there is nowhere to await while a request is
  // being assembled that does not put a round trip in front of every turn.
  expectTypeOf<
    AgentAccepts<{ name: string; promptContext: (ctx: AgentSessionContext) => Promise<string> }>
  >().toEqualTypeOf<false>();
});

/**
 * The context a tool is handed carries where the session is — the committed
 * turn count and the clock — both plain, both pinnable through
 * `createToolContext`.
 */
test("ToolContext carries turn and now()", () => {
  expectTypeOf<ToolContext["turn"]>().toEqualTypeOf<number>();
  expectTypeOf<ReturnType<ToolContext["now"]>>().toEqualTypeOf<number>();
});

/**
 * `systemPrompt` is on the lowered `AgentDef` — the text, or a RESOLVER handed
 * the session rather than nothing (a nullary thunk could vary the prompt by
 * wall clock alone, so it could not read a slot; one is still assignable,
 * pinned below, so a host builder written against that shape keeps compiling)
 * — and on NO member of `agent()`'s union: the prompt is `system-prompt.md`,
 * set on the lowered def by `withSystemPrompt`. The MODE arms are named one by
 * one because `AgentParams` is a union and a field on one arm is a field the
 * others may carry — how `sttPrompt` above came to be refused in S2S mode.
 */
test("systemPrompt is the lowered def's field, and no member of agent() has it", () => {
  type Resolve = (ctx: AgentSessionContext) => string;
  expectTypeOf(agent({ name: "T" }).systemPrompt).toEqualTypeOf<AgentSystemPrompt>();
  expectTypeOf<() => string>().toExtend<Resolver>();
  expectTypeOf<Resolver>().parameter(0).toEqualTypeOf<AgentSessionContext>();
  expectTypeOf<Resolver>().returns.toBeString();
  expectTypeOf<AgentAccepts<{ name: string; systemPrompt: string }>>().toEqualTypeOf<false>();
  expectTypeOf<AgentAccepts<{ name: string; systemPrompt: Resolve }>>().toEqualTypeOf<false>();
  expectTypeOf<
    AgentAccepts<{ name: string; mode: "s2s"; s2s: S2sProvider; systemPrompt: string }>
  >().toEqualTypeOf<false>();
  expectTypeOf<
    AgentAccepts<{ name: string; mode: "text"; systemPrompt: string }>
  >().toEqualTypeOf<false>();
  // A host sets one with a spread over the lowered def, which stays an `AgentDef`.
  const hosted: AgentDef = { ...agent({ name: "T" }), systemPrompt: (ctx) => ctx.sessionId };
  expectTypeOf(hosted.systemPrompt).toEqualTypeOf<AgentSystemPrompt>();
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
 * not — and that reason is a deliberate edit to this test. `speech` is the one
 * such edit so far; the reason is in the test body.
 */
test("AgentSessionContext and SessionEventContext are the same shape, bar `speech` and `turn`", () => {
  // `speech` is one deliberate difference. A `say` queues behind the reply
  // in flight, and a resolver or guardrail runs INSIDE that reply, so speaking
  // from one would queue behind itself; an event handler runs beside the turn.
  // `turn` is the other: a resolver runs once per model request of a turn and
  // may vary the prompt by its count, where a handler is handed the event that
  // is the turn.
  type Twin = Omit<SessionEventContext, "speech">;
  type Resolver = Omit<AgentSessionContext, "turn">;
  expectTypeOf<Resolver>().toExtend<Twin>();
  expectTypeOf<Twin>().toExtend<Resolver>();
  expectTypeOf<keyof Resolver>().toEqualTypeOf<keyof Twin>();
  expectTypeOf<SessionEventContext["speech"]>().toEqualTypeOf<SessionSpeech>();
  expectTypeOf<AgentSessionContext["turn"]>().toEqualTypeOf<number>();
});

/**
 * A roster knows its own names. `persona()` infers each `name` as a literal and
 * `personas()` collects them, so a handoff to a desk that is not on the roster
 * is a compile error in the tool body rather than a throw on a live call. The
 * default parameter keeps a bare `Roster` annotation accepting any roster.
 */
test("persona names are inferred, and a mistyped handoff target does not compile", () => {
  const triage = speaker({ name: "triage", speaks: true, description: "d", systemPrompt: "p" });
  const billing = speaker({ name: "billing", speaks: true, description: "d", systemPrompt: "p" });
  expectTypeOf(triage).toEqualTypeOf<SpeakerDef<"triage">>();
  const desk = roster([triage, billing]);
  expectTypeOf(desk).toEqualTypeOf<Roster<"triage" | "billing">>();
  const ctx = {} as ToolContext;
  desk.handoff(ctx, "billing");
  desk.handoff(ctx, billing);
  type HandoffTo = Parameters<typeof desk.handoff>[1];
  // "biling" is not on the roster, nor is a persona declared for another one.
  expectTypeOf<"biling">().not.toExtend<HandoffTo>();
  expectTypeOf<SpeakerDef<"sales">>().not.toExtend<HandoffTo>();
  // Backward compatible: the default is `string`, and a typed roster fits it.
  const loose: Roster = desk;
  loose.handoff(ctx, "anyone");
  expectTypeOf<SpeakerDef>().toEqualTypeOf<SpeakerDef<string>>();
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
  // A declared event's payload is checked, including a missing field.
  type Progress = Parameters<typeof ctx.send<"typetest.progress">>[1];
  expectTypeOf<Progress>().toEqualTypeOf<{ done: number; total: number }>();
  expectTypeOf<{ done: string; total: number }>().not.toExtend<Progress>();
  expectTypeOf<{ done: number }>().not.toExtend<Progress>();
  ctx.send("anything.else", { whatever: true });
  const name: string = "dynamic";
  ctx.send(name, 42);
});

test("ToolMap is the one tool-map shape AgentDef and SpeakerDef share", () => {
  expectTypeOf<AgentDef["tools"]>().toEqualTypeOf<ToolMap>();
  expectTypeOf<NonNullable<SpeakerDef["tools"]>>().toEqualTypeOf<ToolMap>();
});

declare module "./session-event-map.ts" {
  interface ClientEventMap {
    "typetest.progress": { done: number; total: number };
  }
}
