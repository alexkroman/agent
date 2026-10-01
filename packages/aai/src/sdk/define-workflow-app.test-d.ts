// Copyright 2026 the AAI authors. MIT license.
/**
 * The workflow-app member of `agent()`'s union, and `workflowApp()` over it:
 * what a page over the workflow API may declare, and the session fields it
 * does not have. Split from `define.test-d.ts` at the test-file length cap.
 */
import { expectTypeOf, test } from "vitest";
import type { AgentAccepts } from "./_test-utils.ts";
import type { AgentParams, workflowApp } from "./define.ts";
import type { LlmProvider, S2sProvider } from "./providers.ts";
import type { StateProjection } from "./session-state.ts";
import type { AgentDef } from "./types.ts";

/**
 * The workflow-app arm — the fourth, and the only one keyed on the FRONT DOOR
 * rather than on a session mode.
 *
 * It exists because every field it refuses used to be accepted and inert: a
 * `mode: "workflow-app"` agent has no session and no LLM loop, so a `systemPrompt`
 * on one addresses a model that never runs. The `link-digest-workflow` template shipped
 * exactly that, under a comment claiming `GET /client-config` served it.
 */
test("a workflow app accepts only the fields a workflow app has", () => {
  type Workflows = NonNullable<AgentDef["workflows"]>;

  // The whole legal surface: what a page renders, what it starts, what a step
  // reads.
  expectTypeOf<
    AgentAccepts<{ name: string; mode: "workflow-app"; workflows: Workflows }>
  >().toEqualTypeOf<true>();
  expectTypeOf<
    AgentAccepts<{
      name: string;
      mode: "workflow-app";
      workflows: Workflows;
      greeting: string;
      requiredEnv: readonly string[];
    }>
  >().toEqualTypeOf<true>();

  // `workflows` is the product, so an app declaring none is refused — the page
  // would serve a form whose every submit is a 400.
  expectTypeOf<AgentAccepts<{ name: string; mode: "workflow-app" }>>().toEqualTypeOf<false>();

  // And nothing answers a phone: a carrier's media stream needs the session a
  // workflow app does not have.
  expectTypeOf<
    AgentAccepts<{
      name: string;
      mode: "workflow-app";
      workflows: Workflows;
      telephony: true;
    }>
  >().toEqualTypeOf<false>();

  // Nothing runs a model.
  expectTypeOf<
    AgentAccepts<{
      name: string;
      mode: "workflow-app";
      workflows: Workflows;
      systemPrompt: string;
    }>
  >().toEqualTypeOf<false>();
  expectTypeOf<
    AgentAccepts<{
      name: string;
      mode: "workflow-app";
      workflows: Workflows;
      tools: Record<string, never>;
    }>
  >().toEqualTypeOf<false>();
  expectTypeOf<
    AgentAccepts<{
      name: string;
      mode: "workflow-app";
      workflows: Workflows;
      llm: LlmProvider;
    }>
  >().toEqualTypeOf<false>();
  expectTypeOf<
    AgentAccepts<{
      name: string;
      mode: "workflow-app";
      workflows: Workflows;
      maxSteps: number;
    }>
  >().toEqualTypeOf<false>();

  // Nothing opens a session, so the state projection is out.
  expectTypeOf<
    AgentAccepts<{
      name: string;
      mode: "workflow-app";
      workflows: Workflows;
      syncState: StateProjection;
    }>
  >().toEqualTypeOf<false>();

  // Derived from the two existing lists, so a new provider stage or voice knob
  // is refused here without anyone remembering to list it.
  expectTypeOf<
    AgentAccepts<{
      name: string;
      mode: "workflow-app";
      workflows: Workflows;
      s2s: S2sProvider;
    }>
  >().toEqualTypeOf<false>();
  expectTypeOf<
    AgentAccepts<{
      name: string;
      mode: "workflow-app";
      workflows: Workflows;
      silence: { deadAirCoverMs: number };
    }>
  >().toEqualTypeOf<false>();

  // And the voice arms refuse the front door from their side: without this the
  // arm never bites, because a pipeline agent would match `mode: "workflow-app"` too
  // and go on accepting every field above.
  expectTypeOf<
    AgentAccepts<{ name: string; voice: "jane"; mode: "workflow-app" }>
  >().toEqualTypeOf<false>();
  expectTypeOf<
    AgentAccepts<{
      name: string;
      s2s: S2sProvider;
      mode: "workflow-app";
    }>
  >().toEqualTypeOf<false>();
  // A voice agent may still say so explicitly, and may still declare workflows
  // — the mode is about the front door, not about what the agent may own.
  expectTypeOf<
    AgentAccepts<{ name: string; mode: "pipeline"; workflows: Workflows }>
  >().toEqualTypeOf<true>();
});

/**
 * `workflowApp()` is `agent()` with the discriminant set — same definition
 * type out, so nothing downstream (config, deploy, the guest harness) learns a
 * second shape.
 */
test("workflowApp() returns an AgentDef and takes no page field", () => {
  expectTypeOf<ReturnType<typeof workflowApp>>().toEqualTypeOf<AgentDef>();
  expectTypeOf<Parameters<typeof workflowApp>[0]>().not.toHaveProperty("page");
  expectTypeOf<Parameters<typeof workflowApp>[0]>().toHaveProperty("workflows");
});

/**
 * The workflow-app member does not HAVE the fields a workflow app has no use
 * for — absent, not message-typed — so neither `agent({ mode: "workflow-app" })`
 * nor `workflowApp()` accepts one.
 */
test("the workflow-app member and workflowApp() do not have the session fields", () => {
  type StaticArm = Extract<AgentParams, { mode: "workflow-app" }>;
  expectTypeOf<"maxSteps" extends keyof StaticArm ? true : false>().toEqualTypeOf<false>();
  expectTypeOf<"systemPrompt" extends keyof StaticArm ? true : false>().toEqualTypeOf<false>();
  expectTypeOf<
    AgentAccepts<{
      name: string;
      mode: "workflow-app";
      workflows: NonNullable<AgentDef["workflows"]>;
      maxSteps: number;
    }>
  >().toEqualTypeOf<false>();
  type AppParams = Parameters<typeof workflowApp>[0];
  expectTypeOf<"maxSteps" extends keyof AppParams ? true : false>().toEqualTypeOf<false>();
  expectTypeOf<"systemPrompt" extends keyof AppParams ? true : false>().toEqualTypeOf<false>();
});
