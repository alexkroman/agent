// Copyright 2026 the AAI authors. MIT license.
/**
 * The workflow-app member of `agent()`'s union, and `workflowApp()` over it:
 * what a page over the workflow API may declare, and the session fields it
 * does not have. Split from `define.test-d.ts` at the test-file length cap.
 */
import { expectTypeOf, test } from "vitest";
import { z } from "zod";
import type { AgentAccepts } from "./_test-utils.ts";
import type { ModeAgentDef } from "./agent-params.ts";
import { type AgentParams, agent, workflowApp } from "./define.ts";
import type { LlmProvider, S2sProvider } from "./providers.ts";
import type { StateProjection } from "./session-state.ts";
import type { AgentDef } from "./types.ts";
import { type WorkflowDeclaration, workflow } from "./workflow.ts";
import type { WorkflowOutputOf } from "./workflow-readings.ts";

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
  expectTypeOf<ReturnType<typeof workflowApp>>().toExtend<AgentDef>();
  expectTypeOf<ReturnType<typeof workflowApp>["mode"]>().toEqualTypeOf<"workflow-app">();
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

/**
 * The declared `workflows` map SURVIVES on the result — literal keys, each
 * def's own type — so a page names a workflow through the agent
 * (`useWorkflowSubmit<typeof app>("digest")`) rather than importing the def.
 * `AgentDef` itself keeps the open map, which is right for every other reader.
 */
test("agent() and workflowApp() keep the declared workflows map as declared", () => {
  const digest = workflow({
    input: z.object({ url: z.string() }),
    output: z.object({ headline: z.string() }),
    run: async () => ({ headline: "" }),
  });
  const other = workflow({ run: async () => 1 });
  const app = workflowApp({ name: "A", workflows: { digest, other } });
  expectTypeOf<keyof (typeof app)["workflows"]>().toEqualTypeOf<"digest" | "other">();
  expectTypeOf<(typeof app)["workflows"]["digest"]>().toEqualTypeOf<typeof digest>();
  expectTypeOf<WorkflowOutputOf<(typeof app)["workflows"]["digest"]>>().toEqualTypeOf<{
    headline: string;
  }>();
  expectTypeOf(app).toExtend<AgentDef>();
  expectTypeOf(app.mode).toEqualTypeOf<"workflow-app">();
  // Every voice member keeps it too.
  const voice = agent({ name: "V", workflows: { digest } });
  expectTypeOf<keyof (typeof voice)["workflows"]>().toEqualTypeOf<"digest">();
  expectTypeOf(voice).toExtend<ModeAgentDef<"pipeline">>();
  const text = agent({ name: "T", mode: "text", workflows: { other } });
  expectTypeOf<keyof (typeof text)["workflows"]>().toEqualTypeOf<"other">();
  // And a def declaring none is exactly the mode def — nothing widened.
  expectTypeOf(agent({ name: "P" })).toEqualTypeOf<ModeAgentDef<"pipeline">>();
  expectTypeOf(agent({ name: "T", mode: "text" })).toEqualTypeOf<ModeAgentDef<"text">>();
  // The open map stays assignable where a reader takes the definition.
  const open: AgentDef = app;
  expectTypeOf(open.workflows).toEqualTypeOf<Workflows | undefined>();
  type Workflows = NonNullable<AgentDef["workflows"]>;
});

test("a two-phase declaration's def is a workflow an app may declare", () => {
  type Workflows = NonNullable<AgentDef["workflows"]>;
  type TwoPhaseDef = ReturnType<WorkflowDeclaration["body"]>;
  expectTypeOf<TwoPhaseDef>().toExtend<Workflows[string]>();
  // And the declaration itself is NOT — a workflow with no body cannot run.
  expectTypeOf<WorkflowDeclaration>().not.toExtend<Workflows[string]>();
});
