// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:testing` epoch 27.
 *
 * A template's spec as it was authored at epoch 27 — build the context a tool
 * body is handed, drive a tool through the agent's own table, unwrap a gated
 * result, assert a gate HELD by hand, ask a schema what it accepts, script the
 * two model seams, fake the published slots a step reaches the outside world
 * through, and drive a workflow body without an engine. It must keep compiling
 * for as long as epoch 27 is advertised as supported.
 *
 * ## What moved, and why epoch 27 survives it
 *
 * Epoch 28 ADDED `expectDialogRefused` and `dialogRefusalPattern`. Additive: no
 * existing signature moved, and nothing a spec already called behaves
 * differently.
 *
 * What the addition replaces is a COMPOSITION callers wrote by hand — an
 * `isToolFailure` guard, a `toBe(true)`, and a regex for the sentence the gate
 * writes, two of them re-deriving the JSON escaping an eval reads a tool result
 * through. {@link refusalAt} and {@link refusedAt} below are that hand-written
 * version, which is the whole point of freezing it: seven templates looked like
 * this at epoch 27, and they have to keep compiling whether or not they are
 * ever converted.
 *
 * Nothing here names `expectDialogRefused` or `dialogRefusalPattern`.
 *
 * ## The `/vitest` half is the same capability, and it is REFERENCED
 *
 * `installStubWorkflows` and its options type come from
 * `@alexkroman1/aai/testing/vitest`, which is a second SUBPATH of this one
 * contract rather than a second contract: what is there is only the installation
 * of what is here, split off so the test-runner dependency is opt-in. So it is
 * epoch 27's promise too and it is frozen here; the six `install*` slot fakes are
 * frozen in `v27-slots.ts` for the same reason.
 *
 * That costs nothing, because this file is COMPILED and never executed. An
 * `install*` reaches for `onTestFinished`, which only a running test has — but
 * what a caller depends on is its SIGNATURE, and naming it in a call the
 * compiler checks is the whole of what freezing it means. Not one function
 * below is ever invoked by anything; the evidence is that they all type-check.
 *
 * ## Where a break lands
 *
 * - **Options bags** ({@link CTX}, {@link CLIENT}) are written by the caller, so
 *   a field REMOVED or made required reddens at the literal and a field added
 *   does not. That is the direction a fake's surface actually moves in.
 * - **Result shapes** ({@link WorkflowContextRecorder}, {@link TestToolContext})
 *   are read, so a field or a method going away reddens where it is read.
 * - **Call logs** ({@link RecordedStep}, {@link RecordedSleep},
 *   {@link SentEvent}) are the assertions themselves — a fake that stopped
 *   recording a field does not fail a spec, it makes an assertion unwritable.
 *
 * Editing this file to make a future error go away defeats the mechanism: the
 * error IS the finding, and it means epoch 27 has to be dropped with a reason.
 *
 * ## The example is two files
 *
 * The published step slots and the reporter live in `v27-slots.ts`, the same
 * frozen example in a second module — the file outgrew the 500-line source cap
 * and the section banner was the seam it already had. This one keeps the name
 * because the gate reads `v<N>.ts` by name; the two do NOT import each other,
 * and nothing imports either. What freezes an epoch is that the whole package
 * still COMPILES, and both halves are in the same program.
 */

import {
  createProgressStream,
  createRunSnapshot,
  createStubWorkflows,
  createToolContext,
  createWorkflowContext,
  deployedAgent,
  expectDialogOk,
  expectToolOk,
  type ProjectFiles,
  parseSchemaInput,
  parseToolInput,
  type RecordedSleep,
  type RecordedStep,
  type RunSnapshotOverrides,
  runTool,
  type SentEvent,
  type StubDelegate,
  type StubDelegateCall,
  type StubDelegateReply,
  type StubDelegateRoute,
  type StubGenerate,
  type StubGenerateCall,
  type StubGenerateReply,
  type StubGenerateRoute,
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
  WORKFLOW_CONTEXT_NOW,
  type WorkflowContextOptions,
  type WorkflowContextRecorder,
} from "../../../sdk/testing-barrel.ts";
import {
  installStubWorkflows,
  type StubWorkflowsOptions,
} from "../../../sdk/testing-vitest-barrel.ts";
import { isToolFailure } from "../../../sdk/utils.ts";

// ── The context a tool body is handed ────────────────────────────────────

/**
 * A scripted `ctx.generate`, keyed by the system prompt the node carries.
 *
 * The route is a FUNCTION rather than a fixed reply, which is what a grader
 * asked once per document needs: it can read the call and shift its answer.
 */
const GRADER: StubGenerateRoute = (call: StubGenerateCall): StubGenerateReply =>
  call.prompt.includes("refund") ? { object: { score: 1 } } : "no";

/** The model a tool reasons with. */
export function scriptModel(): StubGenerate {
  return stubGenerate({ "You grade retrieved documents.": GRADER });
}

/**
 * A scripted `ctx.delegate`, keyed by subagent name. `subagent` is the DEF
 * rather than its name, which is what lets a spec assert the budget and the
 * tool surface the parent handed over.
 */
const RESEARCHER: StubDelegateRoute = (call: StubDelegateCall): StubDelegateReply => ({
  text: `${call.subagent.name} looked into: ${call.task}`,
  steps: 3,
});

/** The two subagents a fan-out asks. */
export function scriptDelegation(): StubDelegate {
  return stubDelegate({ researcher: RESEARCHER, "fact-checker": "Both claims check out." });
}

/**
 * The `ctx.workflows` a tool that starts or reads runs is given. Every method it
 * does NOT name rejects, which is the property worth having.
 */
export function toolWorkflows() {
  return createStubWorkflows({
    find: () => Promise.resolve([createRunSnapshot({ status: "running" })]),
  });
}

/**
 * The context a tool body is handed, with the defaults epoch 27 filled. The
 * overrides are annotated because the ANNOTATION is what the type exists for:
 * `ToolContextOverrides` admits an explicit `undefined` per field.
 */
export function context(): TestToolContext {
  const model = scriptModel();
  const desk = scriptDelegation();
  const overrides: ToolContextOverrides = {
    sessionId: "sess_1",
    env: { ASSEMBLYAI_API_KEY: "test-key" },
    generate: model.generate,
    delegate: desk.delegate,
    workflows: toolWorkflows(),
  };
  return createToolContext(overrides);
}

/** What the tool put on the wire — what the browser sees, not a spy. */
export function firstSent(ctx: TestToolContext): SentEvent | undefined {
  return ctx.sent[0];
}

// ── Driving the tools ────────────────────────────────────────────────────

/**
 * The def a DEPLOYED agent runs. The parameter's type is read off the
 * contract's own signature rather than imported from the `agent` capability —
 * a frozen example is evidence about ONE promise.
 */
type Authored = Parameters<typeof deployedAgent>[0];

/** The lowering a spec applies when its runner registers no Vite plugin. */
export function deployed(authored: Authored): Authored {
  const project: ProjectFiles = { systemPrompt: "You take pizza orders." };
  return deployedAgent(authored, project);
}

/** What the model is told a tool is for. */
export function toolDescription(agent: ToolBearingAgent, name: string): string {
  return String(toolOf(agent, name).description);
}

/** One call, unbound — no arguments, so the context takes their place. */
export async function callOnce(agent: ToolBearingAgent, ctx: TestToolContext): Promise<unknown> {
  return await runTool(agent, "view_order", ctx);
}

/** The bound runner every template spec opens with. */
export function bind(agent: ToolBearingAgent): ToolRunner {
  return toolRunner(agent);
}

/** Driving a tool through the agent's own table; `expectToolOk` fails at the CALL. */
export async function callTool(agent: ToolBearingAgent, args: Record<string, unknown>) {
  const run: ToolRunner = bind(agent);
  return expectToolOk(await run("view_order", args));
}

/** The gated shape: a result plus where the dialog landed. */
export async function callGated(agent: ToolBearingAgent): Promise<string> {
  return expectDialogOk(await bind(agent)("confirm_change")).state;
}

/**
 * The gate's own sentence, as an epoch-27 eval spelled it. The character class
 * absorbs the JSON escaping a serialized tool result carries — the state name
 * arrives inside `\"identifying\"` rather than plain quotes.
 */
export const refusalAt = (state: string): RegExp =>
  new RegExp(`Not available yet: this conversation is at [\\\\"]*${state}`);

/**
 * Drive `name` before the dialog has reached its state and read the refusal
 * back — the shape every gated-tool spec had at epoch 27. The hand-rolled half
 * reads `error` off a `ToolFailure`, which is `aai:utils`'s promise, not this
 * capability's.
 */
export async function refusedAt(
  agent: ToolBearingAgent,
  name: string,
  state: string,
): Promise<string | undefined> {
  const refused = await bind(agent)(name, undefined, context());
  if (!isToolFailure(refused)) return undefined;
  return refusalAt(state).test(refused.error) ? refused.error : undefined;
}

// ── Asking a schema what it accepts ──────────────────────────────────────

/** Reading a tool's own input schema, without restating it. */
export function inputOf(agent: ToolBearingAgent, raw: unknown) {
  return parseToolInput(agent, "view_order", raw);
}

/** The negative half — the schema is what stands between an untyped call and the body. */
export function refusedInput(agent: ToolBearingAgent, raw: unknown) {
  return toolInputIssues(agent, "view_order", raw);
}

/** The same pair over a schema the caller HOLDS, which is what a workflow's `input` is. */
type InputSchema = Parameters<typeof parseSchemaInput>[0];

/** What the workflow's own input schema made of a form submission. */
export async function workflowInput(schema: InputSchema, raw: unknown): Promise<{ url: string }> {
  return await parseSchemaInput<{ url: string }>(schema, raw, "the digest workflow");
}

/** And why it refused one. */
export async function workflowInputIssues(schema: InputSchema, raw: unknown) {
  return await schemaInputIssues(schema, raw, "the digest workflow");
}

// ── The workflow body, without an engine ─────────────────────────────────

/**
 * What the recorder answers the body with. `now` is pinned to the contract's
 * own instant rather than to `Date.now` — a fixture that read the clock would
 * not be a fixture.
 */
const CTX: WorkflowContextOptions = {
  runId: "wrun_test",
  workflow: "recap",
  runSteps: true,
  now: WORKFLOW_CONTEXT_NOW,
  results: { fetchPage: "<p>hi</p>" },
  hooks: { "recap:keep": true },
};

/** A workflow BODY driven without the replay engine. */
export function bodyCtx(): WorkflowContextRecorder {
  return createWorkflowContext(CTX);
}

/** Which steps the body reached, in the order it reached them. */
export function stepsReached(ctx: WorkflowContextRecorder): string[] {
  return ctx.steps.map((step: RecordedStep) => step.name);
}

/** The wait the body asked for and did NOT take. */
export function firstWait(ctx: WorkflowContextRecorder): RecordedSleep | undefined {
  return ctx.slept[0];
}

/** And the tokens it parked on. */
export function tokensWaited(ctx: WorkflowContextRecorder): string[] {
  return ctx.waited;
}

// ── Fixtures for a workflow client a tool talks to ───────────────────────

/**
 * A finished run, the right arm of the union, without a cast. The overrides are
 * annotated so `output` is checked against the workflow's own return type.
 */
const COMPLETED: RunSnapshotOverrides<{ summary: string }> = {
  status: "completed",
  output: { summary: "done" },
};

/** Fixtures for a workflow client a tool talks to. */
export function snapshot() {
  return createRunSnapshot(COMPLETED);
}

/** The narration a page reads back off a run. */
export function progress() {
  return createProgressStream(["Fetching the page…", "Summarizing…"]);
}

/**
 * The whole client in one line, for a tool whose reads all succeed. Every
 * field has a default, so a spec names only the one its assertion is about.
 */
const CLIENT: StubWorkflowsOptions = {
  runs: [createRunSnapshot({ status: "running" })],
  names: ["recap"],
  runId: "wrun_stub",
  lastLine: { note: "done" },
};

/** The stubbed client a tool spec passes as `ctx.workflows`. */
export function workflowClient() {
  return installStubWorkflows(CLIENT);
}
